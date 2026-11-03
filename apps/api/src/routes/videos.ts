import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "@vpp/core";
import {
  completeUpload,
  createVideo,
  getPlayback,
  getVideoDetail,
  getVideoStatus,
  listVideos,
} from "../videos.service.ts";

// zod schemas validate untrusted input at runtime AND give us static types.
const CreateVideoBody = z.object({
  title: z.string().trim().min(1).max(200),
  fileName: z.string().min(1).max(255),
  fileSizeBytes: z.number().int().positive().max(config.MAX_UPLOAD_BYTES),
});

const VideoParams = z.object({ videoId: z.uuid() });
const UploadParams = VideoParams.extend({ uploadId: z.uuid() });
const IdempotencyKey = z.string().min(1).max(255).optional();

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.post("/videos", async (req, reply) => {
    const body = CreateVideoBody.parse(req.body);
    const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
    const { response, replayed } = await createVideo(req.userId, body, key);
    if (replayed) reply.header("idempotent-replayed", "true");
    return reply.status(201).send(response);
  });

  app.post("/videos/:videoId/uploads/:uploadId/complete", async (req, reply) => {
    const { videoId, uploadId } = UploadParams.parse(req.params);
    const result = await completeUpload(req.userId, videoId, uploadId);
    return reply.status(202).send(result);
  });

  app.get("/videos", async (req) => ({ videos: await listVideos(req.userId) }));

  app.get("/videos/:videoId", async (req) => {
    const { videoId } = VideoParams.parse(req.params);
    return getVideoDetail(req.userId, videoId);
  });

  app.get("/videos/:videoId/status", async (req) => {
    const { videoId } = VideoParams.parse(req.params);
    return getVideoStatus(req.userId, videoId);
  });

  app.get("/videos/:videoId/playback", async (req) => {
    const { videoId } = VideoParams.parse(req.params);
    return getPlayback(req.userId, videoId);
  });
}
