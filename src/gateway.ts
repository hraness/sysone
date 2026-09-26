import {
  forwardToBackend,
  probeAll,
  runtimeBackends,
  type RuntimeBackend,
} from "./backends.ts";
import { configSchema, isLoopbackHost, type Sys1Config } from "./config.ts";
import { HttpBodyLimitError, readBoundedText } from "./http.ts";
import {
  LocalRunner,
  defaultEngineFactory,
  type DecideResult,
  type LocalAdapter,
  type LocalQuestionDiagnostic,
} from "./local/runner.ts";
import {
  PROTOCOL_LIMITS,
  errorBody,
  serializedBytes,
  systemOneRequestSchema,
  type SystemOneRequest,
} from "./protocol.ts";
import { chooseBackend, requestNeeds } from "./router.ts";
import { ModelStoreError } from "./local/store.ts";
import { validateResponseForRequest } from "./response.ts";
import { adaptKevRequest, adaptKevResponse } from "./kev.ts";

export const SYS1_VERSION = "0.11.0";
const MAX_ATTEMPTS = 2;

export interface GatewayDeps {
  config: Sys1Config;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /**
   * Re-read config per request so `sys1 config set` / `backend add` take
   * effect on a running daemon. May throw; a thrown read answers 503.
   */
  reloadConfig?: () => Sys1Config;
  /**
   * State directory. Required for builtin local models; when absent the
   * gateway only serves URL-registered and hosted backends.
   */
  home?: string;
  /** Injectable local runner (tests substitute a fake engine factory). */
  localRunner?: LocalRunner;
  /** Daemon ownership proof. Standalone embedded gateways omit this. */
  daemon?: { instance: string; onShutdown: () => void | Promise<void> };
}

function currentConfig(deps: GatewayDeps): Sys1Config {
  return deps.reloadConfig === undefined ? deps.config : deps.reloadConfig();
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Model id a backend should see for one request. A caller-pinned
 * `backend/model` resolves to its model part; a bare model passes through;
 * `auto`/absent resolves to the backend's configured default.
 */
function forwardModel(requested: string | undefined, backend: RuntimeBackend): string {
  if (requested === undefined || requested === "auto") return backend.default_model;
  const slash = requested.indexOf("/");
  if (slash > 0) return requested.slice(slash + 1);
  return requested;
}

function localDiagnosticHeaders(
  adapter: LocalAdapter | undefined,
  diagnostics: Record<string, LocalQuestionDiagnostic> | undefined,
): Record<string, string> {
  const values = diagnostics === undefined ? [] : Object.values(diagnostics);
  const coverage = values.length === 0 ? 0 : Math.min(...values.map((value) => value.coverage));
  const concentration =
    values.length === 0 ? 0 : Math.min(...values.map((value) => value.concentration));
  return {
    "x-sys1-local-adapter": adapter ?? "generic-gguf",
    "x-sys1-local-min-coverage": coverage.toFixed(3),
    "x-sys1-local-min-concentration": concentration.toFixed(3),
  };
}

export function createFetchHandler(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  let runner: LocalRunner | null = deps.localRunner ?? null;

  function localRunner(config: Sys1Config): LocalRunner | null {
    if (deps.home === undefined) return null;
    if (runner === null) {
      runner = new LocalRunner({
        home: deps.home,
        maxLoadedModels: config.local.max_loaded_models,
        engineFactory: defaultEngineFactory(
          config.local.context_tokens,
          config.local.eval_timeout_ms,
        ),
      });
    }
    return runner;
  }

  async function boundedLocalDecision(
    active: LocalRunner,
    body: SystemOneRequest,
    modelId: string,
    signal: AbortSignal,
  ): Promise<DecideResult> {
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        active.decide(body, modelId, signal),
        cancelled,
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  function loadActiveConfig(): Sys1Config | Response {
    try {
      return currentConfig(deps);
    } catch (error) {
      return json(
        errorBody(
          "config_invalid",
          error instanceof Error ? error.message : "config could not be loaded",
        ),
        503,
      );
    }
  }

  async function handleModels(config: Sys1Config, signal: AbortSignal): Promise<Response> {
    const backends = runtimeBackends(config, deps.env, deps.home);
    await probeAll(backends, config.gateway.probe_timeout_ms, fetchFn, signal);
    signal.throwIfAborted();
    const data = backends.flatMap((backend) =>
      backend.models.map((id) => ({
        id,
        backend: backend.name,
        kind: backend.kind,
        available: backend.available,
        capabilities: backend.capabilities ?? null,
        explicit_only: backend.explicitOnly === true,
        ...(backend.adapter === undefined ? {} : { adapter: backend.adapter }),
      })),
    );
    return json({ object: "list", data });
  }

  async function handleSystemOne(request: Request, config: Sys1Config, signal: AbortSignal): Promise<Response> {
    const lengthHeader = request.headers.get("content-length");
    if (lengthHeader !== null && Number(lengthHeader) > PROTOCOL_LIMITS.maxBodyBytes) {
      return json(errorBody("request_too_large", "body exceeds 1 MiB"), 413);
    }
    let rawBody: string;
    try {
      rawBody = await readBoundedText(request, PROTOCOL_LIMITS.maxBodyBytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      return error instanceof HttpBodyLimitError
        ? json(errorBody("request_too_large", "body exceeds 1 MiB"), 413)
        : json(errorBody("request_unreadable", "request body could not be read"), 400);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return json(errorBody("invalid_json", "request body is not valid JSON"), 400);
    }
    const parsed = systemOneRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? "" : `${issue.path.join(".")}: `;
      const what = issue === undefined ? "invalid request" : issue.message;
      return json(errorBody("invalid_request", `${where}${what}`), 422);
    }
    const body: SystemOneRequest = parsed.data;
    if (serializedBytes(body.state) > PROTOCOL_LIMITS.maxStateBytes) {
      return json(errorBody("request_too_large", "state exceeds 256 KiB"), 413);
    }

    const backends = runtimeBackends(config, deps.env, deps.home);
    if (backends.length === 0) {
      return json(
        errorBody(
          "no_backend_configured",
          "no backends configured; run `sys1 setup`, `sys1 jev enable`, or add a backend with `sys1 backend add`",
        ),
        503,
      );
    }
    const policy = config.routing.policy;
    const allowedProbes = backends.filter((backend) =>
      policy === "local-only" ? backend.kind === "local"
        : policy === "hosted-only" ? backend.kind === "hosted" : true,
    );
    await probeAll(allowedProbes, config.gateway.probe_timeout_ms, fetchFn, signal);
    signal.throwIfAborted();

    const pinned = body.model !== undefined && body.model.includes("/");
    const needs = requestNeeds(body);
    let remaining = backends;
    let lastTransport: string | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && remaining.length > 0; attempt += 1) {
      signal.throwIfAborted();
      const choice = chooseBackend(policy, body.model, remaining, needs);
      if (!choice.ok) {
        if (lastTransport !== null) break;
        const status =
          choice.reason === "unknown_model"
            ? 404
            : choice.reason === "request_unsupported" || choice.reason === "policy_restricted"
              ? 422
              : 503;
        return json(errorBody(choice.reason, choice.detail), status);
      }
      const backend = choice.backend;
      const hopRequest = { ...body, model: forwardModel(body.model, backend) ?? backend.default_model };
      const forwardedBody = backend.adapter === "kev" ? JSON.stringify(adaptKevRequest(hopRequest)) : rawBody;
      if (new TextEncoder().encode(forwardedBody).byteLength > PROTOCOL_LIMITS.maxBodyBytes) {
        return json(errorBody("request_too_large", "adapted request body exceeds 1 MiB"), 413);
      }
      attempts += 1;
      let result;
      if (backend.builtin !== undefined) {
        const active = localRunner(config);
        if (active === null) {
          result = {
            kind: "response" as const,
            status: 503,
            body: JSON.stringify(errorBody("engine_unavailable", "local runner unavailable")),
            content_type: "application/json",
          };
        } else {
          const decided = await boundedLocalDecision(
            active,
            body,
            backend.builtin.model.id,
            signal,
          );
          result = decided.ok
            ? {
                kind: "response" as const,
                status: 200,
                body: JSON.stringify(decided.response),
                content_type: "application/json",
                extra_headers: localDiagnosticHeaders(decided.adapter, decided.diagnostics),
              }
            : {
                kind: "response" as const,
                status: decided.error?.type === "local_question_unsupported" ? 422
                  : decided.error?.type === "inference_timeout" ? 504
                    : decided.error?.type === "engine_unavailable" ? 503 : 502,
                body: JSON.stringify(errorBody(
                  decided.error?.type ?? "inference_failed",
                  decided.error?.type === "local_question_unsupported"
                    ? "request exceeds the local adapter's supported input limits"
                    : decided.error?.type === "inference_timeout"
                      ? "local inference timed out" : "local inference could not answer the request",
                )),
                content_type: "application/json",
              };
        }
      } else {
        result = await forwardToBackend(
          backend,
          forwardedBody,
          forwardModel(body.model, backend),
          config.gateway.request_timeout_ms,
          fetchFn,
          signal,
        );
      }
      signal.throwIfAborted();
      if (result.kind === "response") {
        let status = result.status;
        let responseBody = result.body;
        let contentType = result.content_type;
        if (status >= 200 && status < 300) {
          contentType = "application/json";
          try {
            const value: unknown = JSON.parse(responseBody ?? "");
            responseBody = JSON.stringify(backend.adapter === "kev"
              ? adaptKevResponse(hopRequest, value)
              : validateResponseForRequest(body, value));
          } catch {
            status = 502;
            responseBody = JSON.stringify(errorBody(
              "backend_response_invalid", "backend response does not match the requested decision contract",
            ));
          }
        }
        return new Response([204, 205, 304].includes(status) ? null : responseBody, {
          status,
          headers: {
            "content-type": contentType,
            "x-sys1-backend": backend.name,
            "x-sys1-attempts": String(attempt + 1),
            ...(backend.adapter === "kev" && status >= 200 && status < 300
              ? { "x-sys1-adapter": "kev", "x-sys1-probability-decimals": "2" } : {}),
            ...("extra_headers" in result ? result.extra_headers : {}),
          },
        });
      }
      lastTransport = result.detail;
      if (pinned) break;
      remaining = remaining.filter((candidate) => candidate.name !== backend.name);
    }

    return json(
      errorBody(
        "no_backend_available",
        `no reachable backend answered the request${lastTransport === null ? "" : ` (${lastTransport})`}`,
      ),
      503,
      { "x-sys1-attempts": String(attempts) },
    );
  }

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, version: SYS1_VERSION,
        ...(deps.daemon === undefined || request.headers.get("authorization") !== `Bearer ${deps.daemon.instance}`
          ? {} : { pid: process.pid, instance: deps.daemon.instance }),
      });
    }
    if (request.method === "POST" && url.pathname === "/_sys1/shutdown" && deps.daemon !== undefined) {
      if (request.headers.get("authorization") !== `Bearer ${deps.daemon.instance}`) {
        return json(errorBody("unauthorized", "daemon ownership proof required"), 401);
      }
      const daemon = deps.daemon;
      setTimeout(() => { void Promise.resolve().then(() => daemon.onShutdown()).catch(() => {}); }, 0);
      return json({ ok: true }, 202);
    }
    const models = request.method === "GET" && url.pathname === "/v1/models";
    const decision = request.method === "POST" && url.pathname === "/v1/systemone";
    if (models || decision) {
      const config = loadActiveConfig();
      if (config instanceof Response) return config;
      // Own a referenced timer for the entire request. An incoming stream can
      // be the only pending work, so its deadline must keep the event loop
      // awake independently of AbortSignal.timeout's runtime timer handling.
      const controller = new AbortController();
      const signal = controller.signal;
      const onCallerAbort = (): void => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", onCallerAbort, { once: true });
      if (request.signal.aborted) onCallerAbort();
      const timer = setTimeout(() => {
        controller.abort(new DOMException("request deadline exceeded", "TimeoutError"));
      }, config.gateway.request_timeout_ms);
      try {
        signal.throwIfAborted();
        return await (models ? handleModels(config, signal) : handleSystemOne(request, config, signal));
      } catch (error) {
        if (request.signal.aborted) {
          return json(errorBody("request_cancelled", "caller cancelled the request"), 499);
        }
        if (signal.aborted) {
          return json(errorBody("inference_timeout", "request deadline exceeded"), 504);
        }
        if (error instanceof ModelStoreError) {
          return json(errorBody("model_store_invalid", "local model inventory is invalid; run `sys1 doctor`. Legacy scorer/Needle inventories require a new SYS1_HOME; existing files were not changed."), 503);
        }
        return json(errorBody("gateway_unavailable", "gateway could not process the request"), 503);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onCallerAbort);
      }
    }
    return json(errorBody("not_found", "unknown route"), 404);
  };
}

export interface RunningGateway {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** Native HTTP clients only; embedded callers retain their own admission policy. */
function networkAdmission(request: Request): Response | null {
  const url = new URL(request.url);
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!isLoopbackHost(hostname) || url.username !== "" || url.password !== "") {
    return json(errorBody("request_host_forbidden", "gateway requires a loopback request authority"), 403);
  }
  const host = request.headers.get("host");
  if (host !== null) {
    try {
      const authority = new URL(`${url.protocol}//${host}`);
      if (authority.origin !== url.origin || authority.username !== "" || authority.password !== "" ||
          authority.pathname !== "/" || authority.search !== "" || authority.hash !== "") {
        return json(errorBody("request_host_forbidden", "request Host must match its loopback authority"), 403);
      }
    } catch {
      return json(errorBody("request_host_forbidden", "request Host is invalid"), 403);
    }
  }
  // Node's fetch sends Sec-Fetch-Mode too, so that header alone is not a
  // browser indicator. Browsers supply Origin or Sec-Fetch-Site; none are
  // admitted because this daemon does not host or authorize a browser UI.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return json(errorBody("browser_request_forbidden", "browser requests are not supported by the local gateway"), 403);
  }
  if (request.method === "POST" && url.pathname === "/v1/systemone" &&
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json(errorBody("unsupported_media_type", "decision requests require application/json"), 415);
  }
  return null;
}

/** Network admission wrapper, shared by the listener and boundary tests. */
export function createNetworkFetchHandler(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const handler = createFetchHandler(deps);
  return async (request: Request): Promise<Response> => {
    const rejected = networkAdmission(request);
    if (rejected !== null) {
      void request.body?.cancel().catch(() => {});
      return rejected;
    }
    return handler(request);
  };
}

export function startGateway(deps: GatewayDeps & { port?: number }): RunningGateway {
  // The module API must preserve the CLI's loopback boundary for JavaScript
  // callers too; TypeScript annotations alone do not validate runtime values.
  const config = configSchema.parse(deps.config);
  const localRunner =
    deps.localRunner ??
    (deps.home === undefined
      ? undefined
      : new LocalRunner({
          home: deps.home,
          maxLoadedModels: config.local.max_loaded_models,
          engineFactory: defaultEngineFactory(
            config.local.context_tokens,
            config.local.eval_timeout_ms,
          ),
        }));
  const handler = createNetworkFetchHandler({ ...deps, config, ...(localRunner === undefined ? {} : { localRunner }) });
  const server = Bun.serve({
    hostname: config.gateway.host,
    port: deps.port ?? config.gateway.port,
    fetch: handler,
    // Bound concurrent intake; this gateway is a loopback service for local agents.
    maxRequestBodySize: PROTOCOL_LIMITS.maxBodyBytes,
  });
  const boundPort = server.port ?? deps.port ?? config.gateway.port;
  return {
    url: `http://${config.gateway.host.includes(":") ? `[${config.gateway.host}]` : config.gateway.host}:${boundPort}`,
    port: boundPort,
    stop: async () => {
      const disposing = localRunner?.dispose();
      await server.stop(true);
      if (disposing !== undefined) await disposing;
    },
  };
}
