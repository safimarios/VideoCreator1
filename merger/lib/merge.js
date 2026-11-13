// محرك الدمج — ffprobe + ffmpeg (libx264 CRF 18 + AAC 192k/44100 + faststart)
// توحيد كل المصادر: scale+pad إلى أكبر دقة (حد 1920×1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p، concat
// مصدر بلا صوت → مسار anullsrc صامت بنفس مدته بدل الفشل
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { CONFIG } = require("./util");

// ثنائيات ffmpeg قد تفقد صلاحية التنفيذ في الاستضافة — نسخة إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `bin-${path.basename(binPath)}-${process.pid}`);
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function ffmpegBin() { return ensureExecutable(ffmpegStatic); }
function ffprobeBin() { return ensureExecutable(ffprobeStatic.path); }

function run(bin, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const feed = (data) => {
      const text = data.toString();
      if (onLine) text.split(/\r?\n/).forEach((l) => l && onLine(l));
    };
    proc.stdout.on("data", feed);
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg/ffprobe exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// استخراج خصائص المصدر: الدقة، الإطارات، المدة، وجود الصوت
async function probeSource(inputPath) {
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    inputPath,
  ];
  let stdout = "";
  const proc = spawn(ffprobeBin(), args);
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffprobe exited ${code}`))));
  });
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالح");
  const [num, den] = String(v.r_frame_rate || "30/1").split("/").map(Number);
  const fps = den ? num / den : 30;
  return {
    width: v.width,
    height: v.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: parseFloat(info.format?.duration ?? v.duration ?? "0") || 0,
    hasAudio: Boolean(a),
  };
}

// تنزيل مصدر URL إلى /tmp مع عدّاد بايتات لفرض حد الحجم أثناء التنزيل
async function downloadSource(url, destPath, onProgress) {
  const limit = CONFIG.SOURCE_MAX_MB * 1024 * 1024;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  if (total > limit) throw new Error(`حجم المصدر يتجاوز الحد (${CONFIG.SOURCE_MAX_MB}MB لكل مصدر)`);
  const file = fs.createWriteStream(destPath);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > limit) {
      file.end();
      throw new Error(`حجم المصدر يتجاوز الحد (${CONFIG.SOURCE_MAX_MB}MB لكل مصدر)`);
    }
    if (onProgress && total) onProgress(received / total);
    if (!file.write(Buffer.from(value))) {
      await new Promise((r) => file.once("drain", r));
    }
  }
  await new Promise((r) => file.end(r));
  return received;
}

// دمج مصادر متعددة → MP4 عالي الجودة. onProgress(percent 40..90 أثناء الترميز)
async function mergeVideos(sources, outputPath, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  try {
    // 1) تجهيز المدخلات: تنزيل URLs أو سحب الملفات المرفوعة من التخزين
    const inputs = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const p = path.join(tmpDir, `in-${i}.bin`);
      if (s.kind === "url") {
        await downloadSource(s.url, p);
      } else {
        const buf = s.buffer;
        if (!buf) throw new Error(`المصدر ${i + 1} غير مكتمل الرفع`);
        fs.writeFileSync(p, buf);
      }
      inputs.push(p);
    }

    // 2) فحص خصائص كل مصدر + حدود المدة الإجمالية
    const probes = [];
    for (const p of inputs) probes.push(await probeSource(p));
    const totalDuration = probes.reduce((a, b) => a + b.duration, 0);
    if (totalDuration > CONFIG.MAX_TOTAL_DURATION_SEC) {
      throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)}ث) يتجاوز الحد (${CONFIG.MAX_TOTAL_DURATION_SEC}ث)`);
    }

    // 3) أكبر دقة مع سقف 1920×1080 وأبعاد زوجية
    let W = Math.max(...probes.map((p) => p.width));
    let H = Math.max(...probes.map((p) => p.height));
    W = Math.min(W, 1920); H = Math.min(H, 1080);
    if (W % 2) W--; if (H % 2) H--;

    // 4) بناء filter_complex: توحيد فيديو + صوت (حقيقي أو صامت)
    const args = ["-y"];
    const silentInputs = []; // فهارس مدخلات anullsrc
    for (let i = 0; i < inputs.length; i++) args.push("-i", inputs[i]);
    for (let i = 0; i < inputs.length; i++) {
      if (!probes[i].hasAudio) silentInputs.push(i);
    }
    for (const _ of silentInputs) {
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    }

    const fc = [];
    let silentIdx = inputs.length;
    for (let i = 0; i < inputs.length; i++) {
      fc.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
      );
      if (probes[i].hasAudio) {
        fc.push(`[${i}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
      } else {
        fc.push(`[${silentIdx}:a]atrim=duration=${probes[i].duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
        silentIdx++;
      }
    }
    const pairs = inputs.map((_, i) => `[v${i}][a${i}]`).join("");
    fc.push(`${pairs}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);

    args.push(
      "-filter_complex", fc.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-crf", "18", "-preset", CONFIG.FFMPEG_PRESET,
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      outputPath
    );

    // 5) ترميز مع قراءة التقدم من -progress pipe:1 → النطاق 40–90
    const totalUs = totalDuration * 1_000_000;
    await run(ffmpegBin(), args, (line) => {
      const m = line.match(/out_time_us=(\d+)/);
      if (m && totalUs > 0 && onProgress) {
        const pct = 40 + Math.min(49, Math.round((Number(m[1]) / totalUs) * 50));
        onProgress(pct);
      }
    });

    const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    if (!size) throw new Error("الترميز أنتج ملفًا فارغًا");
    const outLimit = CONFIG.OUTPUT_MAX_MB * 1024 * 1024;
    if (size > outLimit) throw new Error(`حجم الناتج يتجاوز الحد (${CONFIG.OUTPUT_MAX_MB}MB)`);
    const outProbe = await probeSource(outputPath);

    return {
      size,
      duration: outProbe.duration || totalDuration,
      resolution: `${W}x${H}`,
    };
  } finally {
    // تنظيف /tmp دائمًا — لا اعتماد على نظام ملفات دائم
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { probeSource, mergeVideos, downloadSource, ensureExecutable, ffmpegBin, ffprobeBin };
