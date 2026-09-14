import { createHash } from "crypto";
import { writeFileSync } from "fs";
import { err } from "$lib/logging";
import { bail, fail } from "$lib/utils";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

export default async (c) => {
  try {
    const type = c.req.param("type");

    const body = await c.req.parseBody();
    const file = body.file || Object.values(body).find((v) => v instanceof File);
    if (!file) fail("no file uploaded");

    let buf: Buffer<ArrayBufferLike> = Buffer.from(await (file as File).arrayBuffer());

    // An explicit allowlist, because the check this replaces never ran. It was
    //   format !== "image" && !["jpg","jpeg","png"].includes(ext)
    // — an AND, so `image/*` short-circuited it and the extension list was dead
    // code. Every image type libvips links reached the decoder, TIFF and HEIF
    // included, which is how a high-severity libheif advisory against sharp
    // 0.35.3 was reachable here rather than theoretical.
    //
    // HEIC stays in deliberately: the UI sets no `accept` filter and does no
    // client-side conversion, so an iPhone camera-roll photo arrives as HEIC
    // and dropping it would break avatar uploads for every iOS user.
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
    ]);

    // fileTypeFromBuffer returns undefined when it recognizes nothing, and
    // reading .mime off that threw "undefined is not an object" — an unhelpful
    // 500 where "unsupported file type" is the accurate answer.
    const mime = (await fileTypeFromBuffer(buf as any))?.mime;
    if (!mime || !allowed.has(mime)) fail("unsupported file type");

    const w = type === "banner" ? 1920 : 240;
    buf = await sharp(buf, { failOn: "none" }).rotate().resize(w).webp().toBuffer();

    const hash = createHash("sha256")
      .update(buf as any)
      .digest("hex");

    const filePath = `/home/bun/app/data/uploads/${hash}.webp`;
    writeFileSync(filePath, buf as any);

    return c.json({ hash });
  } catch (e) {
    err("problem uploading", e.message);
    return bail(c, e.message);
  }
};
