const fs = require("node:fs");
const path = require("node:path");

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const task = JSON.parse(fs.readFileSync(path.join(inputDir, "task.json"), "utf8"));
const lines = fs.readFileSync(path.join(inputDir, "history.ndjson"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0);
const marks = lines.map((line) => JSON.parse(line));

const cadenceMinutes = Number(task.cadence_minutes) > 0 ? Number(task.cadence_minutes) : 60;
const parseTime = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const rawMarkTimes = marks.map((mark) =>
  parseTime(mark.at ?? mark.read_at ?? mark.observed_at ?? mark.timestamp ?? mark.time));
const hasMarkTimes = rawMarkTimes.length > 0 && rawMarkTimes.every(Number.isFinite);
const markTimes = marks.map((_, index) =>
  hasMarkTimes ? rawMarkTimes[index] : index * cadenceMinutes * 60_000);
const reads = Array.isArray(task.reads) ? task.reads : [];
const middleRead = reads.length > 0 ? parseTime(reads[Math.floor(reads.length / 2)]) : NaN;
const lastMarkTime = markTimes.at(-1) ?? 0;
const hoursAhead = Number.isFinite(middleRead)
  ? Math.max(0, Math.min(13, (middleRead - lastMarkTime) / 3_600_000))
  : 0;
const cadenceHours = cadenceMinutes / 60;

const observations = new Map();
for (let markIndex = 0; markIndex < marks.length; markIndex += 1) {
  const rows = marks[markIndex]?.rows;
  if (!Array.isArray(rows)) continue;
  for (const row of rows) {
    if (typeof row.mint !== "string" || row.mint.length === 0) continue;
    const lamports = Number(row.market_cap_lamports);
    const rank = Number(row.rank);
    if (!Number.isFinite(lamports) || lamports <= 0 || !Number.isFinite(rank)) continue;
    const samples = observations.get(row.mint) ?? [];
    samples.push({
      index: markIndex,
      x: Math.log10(lamports / 1e9),
      rank,
    });
    observations.set(row.mint, samples);
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const candidates = [];
for (const [mint, samples] of observations) {
  let totalWeight = 0;
  let weightedX = 0;
  let weightedRank = 0;
  for (const sample of samples) {
    const weight = Math.exp(-(marks.length - 1 - sample.index) / 3);
    totalWeight += weight;
    weightedX += weight * sample.x;
    weightedRank += weight * sample.rank;
  }

  const recent = samples.slice(-6);
  const meanIndex = recent.reduce((sum, sample) => sum + sample.index, 0) / recent.length;
  const meanX = recent.reduce((sum, sample) => sum + sample.x, 0) / recent.length;
  const denominator = recent.reduce((sum, sample) => sum + (sample.index - meanIndex) ** 2, 0);
  const slope = denominator > 0
    ? recent.reduce((sum, sample) =>
      sum + (sample.index - meanIndex) * (sample.x - meanX), 0) / denominator
    : 0;

  candidates.push({
    mint,
    meanX: weightedX / totalWeight,
    slope: clamp(slope, -0.25, 0.25),
    meanRank: weightedRank / totalWeight,
    presentLast: samples.at(-1)?.index === marks.length - 1,
  });
}

for (const coin of candidates) {
  coin.predX = coin.meanX + 0.6 * coin.slope * hoursAhead / cadenceHours;
}
candidates.sort((a, b) =>
  b.predX - a.predX || a.meanRank - b.meanRank || a.mint.localeCompare(b.mint));
for (let index = 0; index < candidates.length; index += 1) {
  candidates[index].predRank = index + 1 + (candidates[index].presentLast ? 0 : 3);
}

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;
const probabilities = [];
if (marks.length < 3) {
  const latestByRank = new Map();
  for (const row of marks.at(-1)?.rows ?? []) {
    const rank = Number(row.rank);
    if (typeof row.mint === "string" && Number.isFinite(rank) && !latestByRank.has(rank)) {
      latestByRank.set(rank, row);
    }
  }
  for (let place = 1; place <= 5; place += 1) {
    for (const [rank, p] of [[place, 0.5], [place - 1, 0.15], [place + 1, 0.15]]) {
      const row = latestByRank.get(rank);
      if (row?.mint) probabilities.push({ mint: row.mint, place, p });
    }
  }
} else {
  for (let place = 1; place <= 5; place += 1) {
    const sigma = place <= 2 ? 1.8 : 2.4;
    const nearest = candidates
      .map((coin) => ({
        coin,
        weight: Math.exp(-0.5 * ((coin.predRank - place) / sigma) ** 2),
      }))
      .sort((a, b) =>
        Math.abs(a.coin.predRank - place) - Math.abs(b.coin.predRank - place)
        || a.coin.predRank - b.coin.predRank
        || a.coin.mint.localeCompare(b.coin.mint))
      .slice(0, 10);
    const total = nearest.reduce((sum, item) => sum + item.weight, 0);
    for (const item of nearest) {
      const p = round6(0.95 * item.weight / total);
      if (p > 0) probabilities.push({ mint: item.coin.mint, place, p });
    }
  }
}

const normalCdf = (x) => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return clamp(0.5 * (1 + (x < 0 ? -erf : erf)), 0, 1);
};
const providedEdges = Array.isArray(task.size?.edges) ? task.size.edges.map(Number) : [];
const edges = providedEdges.length === 81 && providedEdges.every(Number.isFinite)
  ? providedEdges
  : Array.from({ length: 81 }, (_, index) => 2 + index * 0.05);
const sizes = [];
for (let place = 1; place <= 5; place += 1) {
  const center = candidates[place - 1]?.predX ?? candidates.at(-1)?.predX ?? 0;
  const sd = 0.45;
  const bins = [];
  for (let bin = 0; bin <= 81; bin += 1) {
    const mass = bin === 0
      ? normalCdf((edges[0] - center) / sd)
      : bin === 81
        ? 1 - normalCdf((edges[80] - center) / sd)
        : normalCdf((edges[bin] - center) / sd)
          - normalCdf((edges[bin - 1] - center) / sd);
    bins.push(Math.max(0, mass));
  }
  const total = bins.reduce((sum, mass) => sum + mass, 0);
  for (let bin = 0; bin <= 81; bin += 1) {
    const p = round6(total > 0 ? bins[bin] / total : 0);
    if (p > 0) sizes.push({ place, bin, p });
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "forecast.json"), JSON.stringify({
  probabilities,
  top5: candidates.slice(0, 5).map((coin) => coin.mint),
  sizes,
}));
