const fs = require("node:fs");
const path = require("node:path");

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const task = JSON.parse(fs.readFileSync(path.join(inputDir, "task.json"), "utf8"));
const lines = fs.readFileSync(path.join(inputDir, "history.ndjson"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0);

const marks = lines.map((line) => JSON.parse(line));
const cadenceHours = (Number(task.cadence_minutes) || 60) / 60;
const parseTime = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 3600000 : NaN;
};
const parsedTimes = marks.map((mark) => {
  const value = mark.read_at ?? mark.observed_at ?? mark.timestamp ?? mark.time ?? mark.at;
  return typeof value === "string" ? parseTime(value) : NaN;
});
const hasMarkTimes = parsedTimes.length > 0 && parsedTimes.every(Number.isFinite);
const times = marks.map((_, index) =>
  hasMarkTimes ? parsedTimes[index] : index * cadenceHours);
const answerTimes = Array.isArray(task.reads) ? task.reads : [];
const lastTime = times.at(-1) ?? 0;
const futureHours = hasMarkTimes
  ? answerTimes
    .map(parseTime)
    .filter((time) => Number.isFinite(time) && time >= lastTime)
    .map((time) => time - lastTime)
  : [];
const horizon = futureHours.length
  ? futureHours.reduce((sum, hours) => sum + hours, 0) / futureHours.length
  : 10;

const observations = new Map();
const latestRows = marks.at(-1)?.rows ?? [];
for (let markIndex = 0; markIndex < marks.length; markIndex += 1) {
  const rows = marks[markIndex]?.rows;
  if (!Array.isArray(rows)) continue;
  for (const row of rows) {
    if (typeof row.mint !== "string" || !row.mint) continue;
    const lamports = Number(row.market_cap_lamports);
    if (!Number.isFinite(lamports) || lamports <= 0) continue;
    const logCap = Math.log10(lamports) - 9;
    if (!observations.has(row.mint)) observations.set(row.mint, []);
    observations.get(row.mint).push({ time: times[markIndex], logCap });
  }
}

const regressionSlope = (samples) => {
  if (samples.length < 3) return 0;
  const newest = samples.at(-1).time;
  const points = samples.slice(-6).map((sample, index, recent) => ({
    x: sample.time - newest,
    y: sample.logCap,
    weight: index + 1,
  }));
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const meanX = points.reduce((sum, point) => sum + point.x * point.weight, 0) / totalWeight;
  const meanY = points.reduce((sum, point) => sum + point.y * point.weight, 0) / totalWeight;
  const numerator = points.reduce(
    (sum, point) => sum + point.weight * (point.x - meanX) * (point.y - meanY), 0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + point.weight * (point.x - meanX) ** 2, 0,
  );
  return denominator > 0 ? numerator / denominator : 0;
};

const candidates = [];
for (const row of latestRows) {
  if (typeof row.mint !== "string" || !row.mint || candidates.some((coin) => coin.mint === row.mint)) continue;
  const samples = observations.get(row.mint) ?? [];
  const rowCap = Number(row.market_cap_lamports);
  const latestCap = samples.at(-1)?.logCap
    ?? (Number.isFinite(rowCap) && rowCap > 0 ? Math.log10(rowCap) - 9 : NaN);
  if (!Number.isFinite(latestCap)) continue;
  const slope = marks.length >= 3 ? regressionSlope(samples) : 0;
  const shift = Math.max(-0.5, Math.min(0.5, slope * 0.35 * horizon));
  candidates.push({ mint: row.mint, cap: latestCap + shift, rank: Number(row.rank) });
}
candidates.sort((a, b) =>
  b.cap - a.cap || (a.rank || Infinity) - (b.rank || Infinity) || a.mint.localeCompare(b.mint));

const normalCdf = (x) => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return Math.max(0, Math.min(1, 0.5 * (1 + (x < 0 ? -erf : erf))));
};

const probabilities = [];
const namedCount = Math.min(25, candidates.length);
for (let place = 1; place <= 5; place += 1) {
  const weights = candidates.map((coin, index) => ({
    coin,
    weight: Math.exp(-0.5 * ((index + 1 - place) / 3.5) ** 2),
  }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weights.slice(0, namedCount)) {
    probabilities.push({ mint: item.coin.mint, place, p: item.weight / total });
  }
}

const edges = Array.isArray(task.size?.edges)
  ? task.size.edges.map(Number).filter(Number.isFinite)
  : Array.from({ length: 81 }, (_, index) => 2 + index * 0.05);
const sizes = [];
for (let place = 1; place <= 5; place += 1) {
  const center = candidates[place - 1]?.cap ?? candidates.at(-1)?.cap ?? 0;
  const sd = 0.55;
  const bins = [];
  for (let bin = 0; bin <= edges.length; bin += 1) {
    let probability;
    if (bin === 0) {
      probability = normalCdf((edges[0] - center) / sd);
    } else if (bin === edges.length) {
      probability = 1 - normalCdf((edges.at(-1) - center) / sd);
    } else {
      probability = normalCdf((edges[bin] - center) / sd)
        - normalCdf((edges[bin - 1] - center) / sd);
    }
    bins.push(Math.max(0, probability));
  }
  const total = bins.reduce((sum, probability) => sum + probability, 0);
  for (let bin = 0; bin < bins.length; bin += 1) {
    sizes.push({ place, bin, p: total > 0 ? bins[bin] / total : 0 });
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "forecast.json"), JSON.stringify({
  probabilities,
  top5: candidates.slice(0, 5).map((coin) => coin.mint),
  sizes,
}));
