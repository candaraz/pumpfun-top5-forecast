const fs = require("node:fs");
const path = require("node:path");

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const task = JSON.parse(fs.readFileSync(path.join(inputDir, "task.json"), "utf8"));
const lines = fs.readFileSync(path.join(inputDir, "history.ndjson"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0);
const marks = lines.map((line) => JSON.parse(line));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const parseTime = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const markTimes = marks.map((mark) => parseTime(mark.at));
const reads = Array.isArray(task.reads) ? task.reads : [];
const middleRead = reads.length > 0 ? parseTime(reads[Math.floor(reads.length / 2)]) : NaN;
const firstMarkTime = markTimes[0];
const lastMarkTime = markTimes.at(-1);
const cadenceSeconds = marks.length > 1
  && Number.isFinite(firstMarkTime)
  && Number.isFinite(lastMarkTime)
  ? (lastMarkTime - firstMarkTime) / (marks.length - 1) / 1000
  : NaN;
const marksAhead = Number.isFinite(middleRead)
  && Number.isFinite(lastMarkTime)
  && Number.isFinite(cadenceSeconds)
  && cadenceSeconds > 0
  ? clamp((middleRead - lastMarkTime) / 1000 / cadenceSeconds, 0, 120)
  : 0;

const usableMarks = [];
for (let index = 0; index < marks.length; index += 1) {
  const rows = marks[index]?.rows;
  if (!Array.isArray(rows) || rows.length < 5) continue;
  const caps = rows.slice(0, 5).map((row) => Number(row.market_cap_lamports) / 1e9);
  if (caps.some((cap) => !Number.isFinite(cap) || cap <= 0)) continue;
  usableMarks.push({ index, at: markTimes[index], x: caps.map(Math.log10) });
}

const ladder = Array.from({ length: 5 }, (_, placeIndex) => {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const mark of usableMarks) {
    const weight = Math.exp(-(marks.length - 1 - mark.index) / 3);
    weightedTotal += weight * mark.x[placeIndex];
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedTotal / totalWeight : 0;
});

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};
const driftByPlace = Array.from({ length: 5 }, (_, placeIndex) => {
  const changes = [];
  for (let index = 1; index < usableMarks.length; index += 1) {
    changes.push(usableMarks[index].x[placeIndex] - usableMarks[index - 1].x[placeIndex]);
  }
  return median(changes);
});
const drift = usableMarks.length >= 2
  ? driftByPlace.reduce((sum, value) => sum + value, 0) / 5
  : 0;
const mu = ladder.map((value, index) => value + drift * marksAhead);
const sd = clamp(0.45 + 0.02 * marksAhead, 0.45, 1.1);

const rankWeights = new Map();
for (let index = 0; index < marks.length; index += 1) {
  const rows = marks[index]?.rows;
  if (!Array.isArray(rows)) continue;
  const weight = Math.exp(-(marks.length - 1 - index) / 3);
  for (const row of rows) {
    if (typeof row.mint !== "string" || row.mint.length === 0) continue;
    const rank = Number(row.rank);
    if (!Number.isFinite(rank)) continue;
    const totals = rankWeights.get(row.mint) ?? { weightedRank: 0, weight: 0 };
    totals.weightedRank += weight * rank;
    totals.weight += weight;
    rankWeights.set(row.mint, totals);
  }
}
const candidates = Array.from(rankWeights, ([mint, totals]) => ({
  mint,
  predictedRank: totals.weightedRank / totals.weight,
})).sort((a, b) => a.predictedRank - b.predictedRank || a.mint.localeCompare(b.mint));

const probabilities = [];
for (let place = 1; place <= 5; place += 1) {
  const candidate = candidates.slice().sort((a, b) =>
    Math.abs(a.predictedRank - place) - Math.abs(b.predictedRank - place)
    || a.mint.localeCompare(b.mint))[0];
  if (candidate) probabilities.push({ mint: candidate.mint, place, p: 0.08 });
}

const normalCdf = (x) => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return clamp(0.5 * (1 + (x < 0 ? -erf : erf)), 0, 1);
};
const edges = task.size?.edges;
if (!Array.isArray(edges) || edges.length !== 81
  || edges.some((edge) => !Number.isFinite(Number(edge)))) {
  throw new Error("task.size.edges must contain 81 finite bin edges");
}
const numericEdges = edges.map(Number);
if (numericEdges.some((edge, index) => index > 0 && edge <= numericEdges[index - 1])) {
  throw new Error("task.size.edges must be strictly increasing");
}
const sizes = [];
for (let place = 1; place <= 5; place += 1) {
  const center = mu[place - 1];
  const masses = [];
  for (let bin = 0; bin <= 81; bin += 1) {
    const mass = bin === 0
      ? normalCdf((numericEdges[0] - center) / sd)
      : bin === 81
        ? 1 - normalCdf((numericEdges[80] - center) / sd)
        : normalCdf((numericEdges[bin] - center) / sd)
          - normalCdf((numericEdges[bin - 1] - center) / sd);
    masses.push(Math.max(0, mass));
  }
  const total = masses.reduce((sum, mass) => sum + mass, 0);
  const rounded = masses.map((mass) =>
    Math.round((total > 0 ? mass / total : 0) * 1_000_000) / 1_000_000);
  const roundedTotal = rounded.reduce((sum, mass) => sum + mass, 0);
  const largestBin = rounded.indexOf(Math.max(...rounded));
  rounded[largestBin] = Math.max(0, rounded[largestBin] + 1 - roundedTotal);
  while (rounded.reduce((sum, mass) => sum + mass, 0) > 1) {
    rounded[largestBin] = Math.max(0, rounded[largestBin] - 0.000001);
  }
  for (let bin = 0; bin <= 81; bin += 1) {
    const p = rounded[bin];
    if (p > 0) sizes.push({ place, bin, p });
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "forecast.json"), JSON.stringify({
  probabilities,
  top5: candidates.slice(0, 5).map((coin) => coin.mint),
  sizes,
}));
