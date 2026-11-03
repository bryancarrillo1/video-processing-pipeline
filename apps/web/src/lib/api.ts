import type {
  ChaosSettings,
  CreateVideoResponse,
  PlaybackInfo,
  SystemView,
  VideoDetail,
  VideoStatus,
  VideoSummary,
} from "@vpp/core/domain";

/** Non-2xx response from the API, carrying its machine-readable error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A generic over the response type: callers say what they expect back
// (`request<VideoDetail>(...)`) and get it typed. Like `def request[T](...) -> T`.
// Note the cast: TypeScript types vanish at runtime, so this trusts the server.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Only declare JSON when there is a body: Fastify rejects an empty JSON body.
  if (init.body) headers.set("content-type", "application/json");

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "http_error", err.message ?? res.statusText, body);
  }
  return body as T;
}

export interface CreateVideoInput {
  title: string;
  fileName: string;
  fileSizeBytes: number;
}

export const api = {
  getSession: () => request<{ username: string | null }>("/session"),
  login: (username: string) =>
    request<{ username: string }>("/session", { method: "POST", body: JSON.stringify({ username }) }),
  logout: () => request<void>("/session", { method: "DELETE" }),

  listVideos: () => request<{ videos: VideoSummary[] }>("/videos").then((r) => r.videos),
  getVideo: (videoId: string) => request<VideoDetail>(`/videos/${videoId}`),
  /** 409 `not_playable` until the first rendition is published. */
  getPlayback: (videoId: string) => request<PlaybackInfo>(`/videos/${videoId}/playback`),

  createVideo: (input: CreateVideoInput, idempotencyKey: string) =>
    request<CreateVideoResponse>("/videos", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "idempotency-key": idempotencyKey },
    }),
  completeUpload: (videoId: string, uploadId: string) =>
    request<{ videoId: string; status: VideoStatus }>(`/videos/${videoId}/uploads/${uploadId}/complete`, {
      method: "POST",
    }),

  // Operator endpoints (internal job management, not the public video API).
  getSystem: () => request<SystemView>("/admin/system"),
  updateChaos: (patch: Partial<ChaosSettings>) =>
    request<ChaosSettings>("/admin/chaos", { method: "PATCH", body: JSON.stringify(patch) }),
  resetChaos: () => request<ChaosSettings>("/admin/chaos/reset", { method: "POST" }),
  killWorker: (workerId: string) =>
    request<{ workerId: string }>(`/admin/workers/${encodeURIComponent(workerId)}/kill`, { method: "POST" }),
  retryJob: (jobId: string) => request<{ jobId: string }>(`/admin/jobs/${jobId}/retry`, { method: "POST" }),
  redriveDeadLetters: () =>
    request<{ messages: number; redriven: number }>("/admin/dlq/redrive", { method: "POST" }),
};
