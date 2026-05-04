import fs from "node:fs/promises";

const CONFIG = {
  stationName: "御前崎",
  jmaPrecNo: "50",
  jmaBlockNo: "47655",
  jmaStationUrlBase: "https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php",

  // 御前崎特別地域気象観測所付近
  // 気象庁資料: 34°36.2′N / 138°12.8′E
  latitude: Number(process.env.EVAL_LAT ?? 34.603333),
  longitude: Number(process.env.EVAL_LON ?? 138.213333),

  outputDir: process.env.EVAL_OUTPUT_DIR ?? "reports",
  days: Number(process.env.EVAL_DAYS ?? 183),

  gustThresholds: [15, 20],
  retryCount: 3,
};

function formatJstYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toJstDate(ymd) {
  return new Date(`${ymd}T00:00:00+09:00`);
}

function addDays(ymd, days) {
  const d = toJstDate(ymd);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return formatJstYmd(d);
}

function ymdParts(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
}

function monthList(startYmd, endYmd) {
  const start = ymdParts(startYmd);
  const end = ymdParts(endYmd);
  const months = [];

  let y = start.year;
  let m = start.month;

  while (y < end.year || (y === end.year && m <= end.month)) {
    months.push({ year: y, month: m });
    m += 1;

    if (m === 13) {
      m = 1;
      y += 1;
    }
  }

  return months;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.retryCount; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          "User-Agent": "omaezaki-openmeteo-evaluator/1.0",
          ...(options.headers ?? {}),
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return res;
    } catch (err) {
      lastError = err;

      if (attempt < CONFIG.retryCount) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw lastError;
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  const buffer = await res.arrayBuffer();

  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
  }
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseNumToken(token) {
  if (token == null) return null;

  const cleaned = String(token)
    .replace(/[−ー]/g, "-")
    .replace(/[^0-9.\-]/g, "");

  if (!cleaned || cleaned === "-" || cleaned === ".") return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTimeToken(token) {
  if (!token) return null;

  const m = String(token).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);

  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseJmaDailyWindHtml(html, year, month) {
  const rows = [];
  const trRegex = /<tr[^>]*class=["']?mtx["']?[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = trRegex.exec(html)) !== null) {
    const text = stripTags(match[1]);
    const tokens = text.split(" ").filter(Boolean);
    const day = Number(tokens[0]);

    if (!Number.isInteger(day) || day < 1 || day > 31) continue;

    // daily_s1.php?view=a4 の「詳細（風・日照・雪・その他）」想定
    // 日, 平均風速, 最大風速, 最大風速の風向, 最大風速の時分,
    // 最大瞬間風速, 最大瞬間風速の風向, 最大瞬間風速の時分, 最多風向, ...
    const avgWind = parseNumToken(tokens[1]);
    const maxWind = parseNumToken(tokens[2]);
    const maxWindDir = tokens[3] ?? "";
    const maxWindTime = parseTimeToken(tokens[4]);
    const maxGust = parseNumToken(tokens[5]);
    const maxGustDir = tokens[6] ?? "";
    const maxGustTime = parseTimeToken(tokens[7]);

    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    if (avgWind == null && maxWind == null && maxGust == null) continue;

    rows.push({
      date,
      jmaAvgWind: avgWind,
      jmaMaxWind: maxWind,
      jmaMaxWindDir: maxWindDir,
      jmaMaxWindTime: maxWindTime,
      jmaMaxGust: maxGust,
      jmaMaxGustDir: maxGustDir,
      jmaMaxGustTime: maxGustTime,
    });
  }

  return rows;
}

async function fetchJmaDailyWind(startDate, endDate) {
  const all = [];

  for (const { year, month } of monthList(startDate, endDate)) {
    const url =
      `${CONFIG.jmaStationUrlBase}` +
      `?prec_no=${CONFIG.jmaPrecNo}` +
      `&block_no=${CONFIG.jmaBlockNo}` +
      `&year=${year}` +
      `&month=${month}` +
      `&day=` +
      `&view=a4`;

    console.log(`JMA: ${year}-${String(month).padStart(2, "0")}`);

    const html = await fetchText(url);
    const rows = parseJmaDailyWindHtml(html, year, month);

    all.push(...rows);

    await sleep(300);
  }

  return all.filter((r) => r.date >= startDate && r.date <= endDate);
}

function chunkDateRanges(startDate, endDate, chunkDays = 31) {
  const chunks = [];
  let s = startDate;

  while (s <= endDate) {
    let e = addDays(s, chunkDays - 1);
    if (e > endDate) e = endDate;

    chunks.push({ start: s, end: e });
    s = addDays(e, 1);
  }

  return chunks;
}

async function fetchOpenMeteoHistorical(startDate, endDate) {
  const hourly = {
    time: [],
    temperature_2m: [],
    precipitation: [],
    wind_speed_10m: [],
    wind_direction_10m: [],
    wind_gusts_10m: [],
  };

  for (const chunk of chunkDateRanges(startDate, endDate, 31)) {
    const params = new URLSearchParams({
      latitude: String(CONFIG.latitude),
      longitude: String(CONFIG.longitude),
      start_date: chunk.start,
      end_date: chunk.end,
      hourly: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      timezone: "Asia/Tokyo",
      wind_speed_unit: "ms",
    });

    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?${params.toString()}`;

    console.log(`Open-Meteo: ${chunk.start} - ${chunk.end}`);

    const res = await fetchWithRetry(url);
    const data = await res.json();

    if (!data.hourly?.time?.length) {
      throw new Error(`Open-Meteo hourly data not found: ${chunk.start} - ${chunk.end}`);
    }

    for (const key of Object.keys(hourly)) {
      hourly[key].push(...(data.hourly[key] ?? []));
    }

    await sleep(300);
  }

  return hourly;
}

function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;

  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function maxWithTime(items, valueKey) {
  let best = null;

  for (const item of items) {
    const v = item[valueKey];

    if (!Number.isFinite(v)) continue;

    if (!best || v > best.value) {
      best = {
        value: v,
        time: item.time,
      };
    }
  }

  return best;
}

function aggregateOpenMeteoDaily(hourly) {
  const byDate = new Map();

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    const date = time.slice(0, 10);

    if (!byDate.has(date)) byDate.set(date, []);

    byDate.get(date).push({
      time,
      temp: hourly.temperature_2m[i],
      precipitation: hourly.precipitation[i],
      wind: hourly.wind_speed_10m[i],
      dir: hourly.wind_direction_10m[i],
      gust: hourly.wind_gusts_10m[i],
    });
  }

  const rows = [];

  for (const [date, items] of [...byDate.entries()].sort()) {
    const maxWind = maxWithTime(items, "wind");
    const maxGust = maxWithTime(items, "gust");

    rows.push({
      date,
      omAvgWind: mean(items.map((x) => x.wind)),
      omMaxWind: maxWind?.value ?? null,
      omMaxWindTime: maxWind?.time?.slice(11, 16) ?? null,
      omMaxGust: maxGust?.value ?? null,
      omMaxGustTime: maxGust?.time?.slice(11, 16) ?? null,
      omAvgTemp: mean(items.map((x) => x.temp)),
      omPrecipitationTotal: items
        .map((x) => x.precipitation)
        .filter((v) => Number.isFinite(v))
        .reduce((a, b) => a + b, 0),
    });
  }

  return rows;
}

function joinDaily(jmaRows, omRows) {
  const omByDate = new Map(omRows.map((r) => [r.date, r]));

  return jmaRows
    .map((jma) => ({
      ...jma,
      ...(omByDate.get(jma.date) ?? {}),
    }))
    .filter((r) => r.omAvgWind != null || r.omMaxWind != null || r.omMaxGust != null);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return "";
  return Number(value).toFixed(digits);
}

function pearson(xs, ys) {
  const pairs = xs
    .map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  if (pairs.length < 2) return null;

  const mx = mean(pairs.map(([x]) => x));
  const my = mean(pairs.map(([, y]) => y));

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    denX += (x - mx) ** 2;
    denY += (y - my) ** 2;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? null : num / den;
}

function metrics(rows, obsKey, predKey) {
  const pairs = rows
    .map((r) => ({
      obs: r[obsKey],
      pred: r[predKey],
    }))
    .filter((p) => Number.isFinite(p.obs) && Number.isFinite(p.pred));

  if (pairs.length === 0) {
    return {
      n: 0,
      mae: null,
      rmse: null,
      bias: null,
      corr: null,
    };
  }

  const errors = pairs.map((p) => p.pred - p.obs);

  return {
    n: pairs.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((e) => e ** 2))),
    bias: mean(errors),
    corr: pearson(
      pairs.map((p) => p.obs),
      pairs.map((p) => p.pred)
    ),
  };
}

function thresholdStats(rows, threshold) {
  let hit = 0;
  let miss = 0;
  let falseAlarm = 0;
  let correctNegative = 0;

  for (const r of rows) {
    if (!Number.isFinite(r.jmaMaxGust) || !Number.isFinite(r.omMaxGust)) continue;

    const obs = r.jmaMaxGust >= threshold;
    const pred = r.omMaxGust >= threshold;

    if (obs && pred) hit += 1;
    else if (obs && !pred) miss += 1;
    else if (!obs && pred) falseAlarm += 1;
    else correctNegative += 1;
  }

  const pod = hit + miss === 0 ? null : hit / (hit + miss);
  const far = hit + falseAlarm === 0 ? null : falseAlarm / (hit + falseAlarm);
  const csi = hit + miss + falseAlarm === 0 ? null : hit / (hit + miss + falseAlarm);

  return {
    threshold,
    hit,
    miss,
    falseAlarm,
    correctNegative,
    pod,
    far,
    csi,
  };
}

function timeToMinutes(hhmm) {
  const t = parseTimeToken(hhmm);
  if (!t) return null;

  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function circularHourDiff(a, b) {
  const ma = timeToMinutes(a);
  const mb = timeToMinutes(b);

  if (ma == null || mb == null) return null;

  const diff = Math.abs(ma - mb) / 60;
  return Math.min(diff, 24 - diff);
}

function peakTimeStats(rows) {
  const diffs = rows
    .map((r) => circularHourDiff(r.jmaMaxGustTime, r.omMaxGustTime))
    .filter((v) => Number.isFinite(v));

  return {
    n: diffs.length,
    meanAbsHourDiff: mean(diffs),
    within1h: diffs.filter((d) => d <= 1).length,
    within2h: diffs.filter((d) => d <= 2).length,
    within3h: diffs.filter((d) => d <= 3).length,
  };
}

function csvEscape(value) {
  if (value == null) return "";

  const s = String(value);

  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

function toCsv(rows) {
  const headers = [
    "date",
    "jmaAvgWind",
    "omAvgWind",
    "avgWindError_om_minus_jma",
    "jmaMaxWind",
    "omMaxWind",
    "maxWindError_om_minus_jma",
    "jmaMaxWindTime",
    "omMaxWindTime",
    "jmaMaxGust",
    "omMaxGust",
    "maxGustError_om_minus_jma",
    "jmaMaxGustTime",
    "omMaxGustTime",
    "gustPeakHourDiff",
    "omAvgTemp",
    "omPrecipitationTotal",
  ];

  const lines = [headers.join(",")];

  for (const r of rows) {
    const line = headers.map((h) => {
      let value;

      switch (h) {
        case "avgWindError_om_minus_jma":
          value =
            Number.isFinite(r.omAvgWind) && Number.isFinite(r.jmaAvgWind)
              ? r.omAvgWind - r.jmaAvgWind
              : null;
          break;

        case "maxWindError_om_minus_jma":
          value =
            Number.isFinite(r.omMaxWind) && Number.isFinite(r.jmaMaxWind)
              ? r.omMaxWind - r.jmaMaxWind
              : null;
          break;

        case "maxGustError_om_minus_jma":
          value =
            Number.isFinite(r.omMaxGust) && Number.isFinite(r.jmaMaxGust)
              ? r.omMaxGust - r.jmaMaxGust
              : null;
          break;

        case "gustPeakHourDiff":
          value = circularHourDiff(r.jmaMaxGustTime, r.omMaxGustTime);
          break;

        default:
          value = r[h];
      }

      return csvEscape(Number.isFinite(value) ? round(value, 3) : value);
    });

    lines.push(line.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function mdTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function generateMarkdown({
  startDate,
  endDate,
  rows,
  metricSummary,
  thresholdSummaries,
  peakStats,
}) {
  const createdAt = new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });

  const topGustRows = [...rows]
    .filter((r) => Number.isFinite(r.jmaMaxGust) && Number.isFinite(r.omMaxGust))
    .sort((a, b) => b.jmaMaxGust - a.jmaMaxGust)
    .slice(0, 15)
    .map((r) => [
      r.date,
      round(r.jmaMaxGust, 1),
      r.jmaMaxGustTime ?? "",
      round(r.omMaxGust, 1),
      r.omMaxGustTime ?? "",
      round(r.omMaxGust - r.jmaMaxGust, 1),
    ]);

  const missRows = [...rows]
    .filter((r) => Number.isFinite(r.jmaMaxGust) && Number.isFinite(r.omMaxGust))
    .filter((r) => r.jmaMaxGust >= 15 && r.omMaxGust < 15)
    .sort((a, b) => b.jmaMaxGust - a.jmaMaxGust)
    .slice(0, 15)
    .map((r) => [
      r.date,
      round(r.jmaMaxGust, 1),
      r.jmaMaxGustTime ?? "",
      round(r.omMaxGust, 1),
      r.omMaxGustTime ?? "",
      round(r.omMaxGust - r.jmaMaxGust, 1),
    ]);

  const metricRows = [
    [
      "日平均風速",
      metricSummary.avgWind.n,
      round(metricSummary.avgWind.mae, 2),
      round(metricSummary.avgWind.rmse, 2),
      round(metricSummary.avgWind.bias, 2),
      round(metricSummary.avgWind.corr, 2),
    ],
    [
      "日最大風速",
      metricSummary.maxWind.n,
      round(metricSummary.maxWind.mae, 2),
      round(metricSummary.maxWind.rmse, 2),
      round(metricSummary.maxWind.bias, 2),
      round(metricSummary.maxWind.corr, 2),
    ],
    [
      "日最大瞬間風速/突風",
      metricSummary.maxGust.n,
      round(metricSummary.maxGust.mae, 2),
      round(metricSummary.maxGust.rmse, 2),
      round(metricSummary.maxGust.bias, 2),
      round(metricSummary.maxGust.corr, 2),
    ],
  ];

  const thresholdRows = thresholdSummaries.map((s) => [
    `${s.threshold}m/s以上`,
    s.hit,
    s.miss,
    s.falseAlarm,
    s.correctNegative,
    s.pod == null ? "" : `${round(s.pod * 100, 1)}%`,
    s.far == null ? "" : `${round(s.far * 100, 1)}%`,
    s.csi == null ? "" : `${round(s.csi * 100, 1)}%`,
  ]);

  const peakRows = [
    [
      peakStats.n,
      round(peakStats.meanAbsHourDiff, 2),
      `${peakStats.within1h}/${peakStats.n}`,
      `${peakStats.within2h}/${peakStats.n}`,
      `${peakStats.within3h}/${peakStats.n}`,
    ],
  ];

  return `# Open-Meteo 性能評価レポート：${CONFIG.stationName}周辺

生成日時：${createdAt} JST  
評価期間：${startDate} 〜 ${endDate}  
比較地点：気象庁 ${CONFIG.stationName} 観測所 / Open-Meteo 座標 ${CONFIG.latitude}, ${CONFIG.longitude}  
データ数：${rows.length}日

## 評価の前提

- 観測値は気象庁の ${CONFIG.stationName} の日別値です。
- Open-Meteo は Historical Forecast API の時間別データを日別に集計しています。
- Open-Meteo の日最大突風は、1時間ごとの wind_gusts_10m の最大値です。
- 気象庁の日最大瞬間風速と Open-Meteo の時間別突風は、観測方法・時間解像度・地点条件が完全一致しないため、厳密な同一物ではありません。
- ここでは「御前崎周辺の強風リスクをOpen-Meteoが拾えるか」を見るための実用評価として扱います。

## 1. 連続値の誤差

MAE/RMSE/Bias の単位は m/s です。Bias は Open-Meteo − 気象庁です。正なら Open-Meteo が強め、負なら弱めです。

${mdTable(["項目", "n", "MAE", "RMSE", "Bias", "相関"], metricRows)}

## 2. 突風しきい値評価

「見逃し」が多い場合は、アプリ側の警告しきい値を下げる必要があります。  
「空振り」が多い場合は、通知が多くなります。

${mdTable(["しきい値", "的中", "見逃し", "空振り", "正常", "検出率", "空振り率", "CSI"], thresholdRows)}

## 3. 突風ピーク時刻のズレ

${mdTable(["n", "平均絶対ズレ 時間", "±1時間以内", "±2時間以内", "±3時間以内"], peakRows)}

## 4. 気象庁の最大瞬間風速が大きかった日 上位15件

${mdTable(
  ["日付", "気象庁 最大瞬間", "気象庁 時刻", "Open-Meteo 最大突風", "Open-Meteo 時刻", "差"],
  topGustRows.length ? topGustRows : [["該当なし", "", "", "", "", ""]]
)}

## 5. 15m/s以上の見逃し 上位15件

${mdTable(
  ["日付", "気象庁 最大瞬間", "気象庁 時刻", "Open-Meteo 最大突風", "Open-Meteo 時刻", "差"],
  missRows.length ? missRows : [["該当なし", "", "", "", "", ""]]
)}

## 6. 読み方

- 日最大瞬間風速/突風の MAE が大きい場合でも、15m/s以上・20m/s以上の検出率が高ければ、警告用途には使える可能性があります。
- 20m/s以上の見逃しが出る場合、営業停止・作業停止の判断に直結させるには危険です。
- Bias が負に大きい場合、Open-Meteo は御前崎の突風を弱めに出す傾向があります。この場合はアプリの黄色・赤色しきい値を下げる補正が必要です。
- ピーク時刻のズレが大きい場合、毎時警告よりも「数時間幅で注意」を出す運用が向いています。
`;
}

async function main() {
  const defaultEndDate = addDays(formatJstYmd(new Date()), -1);
  const endDate = process.env.EVAL_END_DATE ?? defaultEndDate;
  const startDate = process.env.EVAL_START_DATE ?? addDays(endDate, -(CONFIG.days - 1));

  console.log(`Evaluation period: ${startDate} - ${endDate}`);
  console.log(`Open-Meteo coords: ${CONFIG.latitude}, ${CONFIG.longitude}`);

  const [jmaRows, omHourly] = await Promise.all([
    fetchJmaDailyWind(startDate, endDate),
    fetchOpenMeteoHistorical(startDate, endDate),
  ]);

  const omDaily = aggregateOpenMeteoDaily(omHourly);
  const rows = joinDaily(jmaRows, omDaily);

  if (rows.length === 0) {
    throw new Error("No matched rows. Check JMA parser, date range, or Open-Meteo response.");
  }

  const metricSummary = {
    avgWind: metrics(rows, "jmaAvgWind", "omAvgWind"),
    maxWind: metrics(rows, "jmaMaxWind", "omMaxWind"),
    maxGust: metrics(rows, "jmaMaxGust", "omMaxGust"),
  };

  const thresholdSummaries = CONFIG.gustThresholds.map((t) => thresholdStats(rows, t));
  const peakStats = peakTimeStats(rows);

  await fs.mkdir(CONFIG.outputDir, { recursive: true });

  const md = generateMarkdown({
    startDate,
    endDate,
    rows,
    metricSummary,
    thresholdSummaries,
    peakStats,
  });

  const csv = toCsv(rows);

  const summaryJson = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      period: {
        startDate,
        endDate,
      },
      station: {
        name: CONFIG.stationName,
        jmaPrecNo: CONFIG.jmaPrecNo,
        jmaBlockNo: CONFIG.jmaBlockNo,
        latitude: CONFIG.latitude,
        longitude: CONFIG.longitude,
      },
      rows: rows.length,
      metrics: metricSummary,
      thresholds: thresholdSummaries,
      peakTime: peakStats,
    },
    null,
    2
  );

  await fs.writeFile(`${CONFIG.outputDir}/openmeteo-evaluation.md`, md, "utf8");
  await fs.writeFile(`${CONFIG.outputDir}/openmeteo-evaluation-daily.csv`, csv, "utf8");
  await fs.writeFile(`${CONFIG.outputDir}/openmeteo-evaluation-summary.json`, `${summaryJson}\n`, "utf8");

  console.log(`Wrote ${CONFIG.outputDir}/openmeteo-evaluation.md`);
  console.log(`Wrote ${CONFIG.outputDir}/openmeteo-evaluation-daily.csv`);
  console.log(`Wrote ${CONFIG.outputDir}/openmeteo-evaluation-summary.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});