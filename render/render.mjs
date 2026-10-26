// Free render worker: runs in GitHub Actions with FFmpeg.
// Downloads images + narration + captions via signed URLs, builds a cinematic
// documentary (per-scene camera moves, dip-to-black fades, color grade, grain,
// title card, burned captions), uploads through a one-time signed upload URL,
// then calls back the app.
import { createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const payload = JSON.parse(process.env.PAYLOAD);
const W = payload.config?.width ?? 1920;
const H = payload.config?.height ?? 1080;
const FPS = payload.config?.fps ?? 30;
const TITLE = payload.config?.title ?? "History documentary";
const RENDER_UPLOAD_SECRET = process.env.RENDER_UPLOAD_SECRET;
if (!RENDER_UPLOAD_SECRET) throw new Error("RENDER_UPLOAD_SECRET secret is missing on the runner");

// The runner's static FFmpeg has libass (subtitles/ass) but no drawtext filter,
// so the title card and captions are both burned via ASS subtitle files.
// ASS escapes: strip braces/backslashes/newlines from display text.
function esc(t) {
  return t.replace(/[{}\\\r\n]/g, " ").trim();
}

function assTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

const work = await mkdtemp(path.join(tmpdir(), "render-"));

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed [${res.status}] ${file}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
}

function ff(args) {
  return exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1024 * 1024 * 32 });
}

function cameraFilter(camera, frames) {
  const base = `scale=${W * 2}:-2,zoompan=`;
  const tail = `d=${frames}:s=${W}x${H}:fps=${FPS}`;
  switch (camera) {
    case "zoom-out":
      return `${base}z='max(1.25-0.0012*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${tail}`;
    case "pan-right":
      return `${base}z='min(1.15,1.15)':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':${tail}`;
    case "pan-left":
      return `${base}z='min(1.15,1.15)':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':${tail}`;
    case "push-up":
      return `${base}z='min(1+0.0013*on,1.22)':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})':${tail}`;
    case "zoom-in":
    default:
      return `${base}z='min(1+0.0015*on,1.20)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${tail}`;
  }
}

const segments = [];
try {
  const n = payload.images.length;
  for (let i = 0; i < n; i++) {
    const imgFile = path.join(work, `img-${i}.png`);
    const audFile = path.join(work, `aud-${i}.wav`);
    await download(payload.images[i].url, imgFile);
    await download(payload.narration[i].url, audFile);

    const dur = payload.narration[i].duration_ms / 1000 + 0.8; // breathing pause per scene
    const frames = Math.round(dur * FPS);
    const out = path.join(work, `seg-${String(i).padStart(3, "0")}.mp4`);
    segments.push(out);

    const fadeDur = Math.min(0.45, dur / 4).toFixed(3);
    console.log(`Segment ${i + 1}/${n} (${dur.toFixed(1)}s, camera ${payload.images[i].camera ?? "zoom-in"})`);
    await ff([
      "-loop", "1", "-i", imgFile,
      "-i", audFile,
      "-filter_complex",
      `[0:v]${cameraFilter(payload.images[i].camera ?? "zoom-in", frames)},` +
        `eq=contrast=1.06:saturation=1.08,` +
        `vignette=PI/5,` +
        `fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${(dur - 0.2).toFixed(3)}:d=0.2,` +
        `format=yuv420p[v];` +
        `[1:a]aresample=48000,apad=whole_dur=${dur.toFixed(3)}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", dur.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      out,
    ]);
  }

  // concatenate with stream copy (keeps caption timing in sync)
  const listFile = path.join(work, "list.txt");
  await writeFile(listFile, segments.map((s) => `file '${s}'`).join("\n"));
  const base = path.join(work, "base.mp4");
  await ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", base]);

  // captions
  const srtFile = path.join(work, "captions.srt");
  await download(payload.srt_url, srtFile);

  // finishing pass: film grain + burned captions + title card + closing fade
  const final = path.join(work, "final.mp4");
  // Captions via libass: pick a serif font present on the runner, else libass default.
  const FONTS_DIR = "/usr/share/fonts";
  const FONT_CANDIDATES = ["DejaVu Serif", "Liberation Serif", "FreeSerif"];
  const FONT_FAMILY = FONT_CANDIDATES[0]; // ubuntu-24.04 runners ship DejaVu fonts
  const captionStyle = `FontName=${FONT_FAMILY},FontSize=17,Outline=2,Shadow=1,MarginV=48`;

  const totalDuration = payload.narration.reduce((s, x) => s + x.duration_ms / 1000, 0) + n * 0.8;

  // Title card as an ASS overlay (drawtext is unavailable on the static build).
  // Top-center, white serif on a soft black box, fade in/out over the first 6.5s.
  const titleAss = path.join(work, "title.ass");
  await writeFile(
    titleAss,
    [
      "[Script Info]",
      "ScriptType: v4.00+",
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      `PlayResX: ${W}`,
      `PlayResY: ${H}`,
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Title,${FONT_FAMILY},54,&H00FFFFFF,&H000000FF,&H8C000000,&H8C000000,0,0,0,0,100,100,0,0,3,18,0,8,60,60,${Math.round(H * 0.16)},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      `Dialogue: 0,${assTime(0.6)},${assTime(6.5)},Title,,0,0,0,,{\\fad(600,600)}${esc(TITLE)}`,
      "",
    ].join("\n"),
  );

  console.log("Finishing pass (grain, title card, captions)");
  await ff([
    "-i", base,
    "-vf",
    `subtitles=${srtFile}:force_style='${captionStyle}':fontsdir=${FONTS_DIR}` +
      `,subtitles=${titleAss}:fontsdir=${FONTS_DIR}` +
      `,noise=alls=5:allf=t+u,` +
      `fade=t=out:st=${Math.max(0, totalDuration - 1.5)}:d=1.5` +
      `,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    final,
  ]);

  // probe duration
  let duration = 0;
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final,
    ]);
    duration = Math.round(parseFloat(stdout.trim()));
  } catch {
    duration = Math.round(payload.narration.reduce((s, x) => s + x.duration_ms / 1000, 0) + n * 0.8);
  }
  console.log(`Render done: ${duration}s`);

  // upload through the one-time signed URL
  console.log("Uploading video");
  const size = statSync(final).size;
  const up = await fetch(payload.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: createReadStream(final),
    duplex: "half",
  });
  if (!up.ok) {
    const body = await up.text().catch(() => "");
    throw new Error(`Upload failed [${up.status}]: ${body.slice(0, 300)}`);
  }

  // callback
  const body = JSON.stringify({
    job_id: payload.job_id,
    video_path: decodeURIComponent((new URL(payload.upload_url).pathname.split("/object/sign/")[1] ?? "").split("?")[0]),
    duration_seconds: duration,
  });
  const signature = createHmac("sha256", RENDER_UPLOAD_SECRET).update(body).digest("hex");
  const cb = await fetch(`${payload.app_url}/api/public/renders/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Render-Signature": signature },
    body,
  });
  console.log(`Callback: ${cb.status}`);
  if (!cb.ok) {
    const t = await cb.text().catch(() => "");
    throw new Error(`Callback failed [${cb.status}]: ${t.slice(0, 300)}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
