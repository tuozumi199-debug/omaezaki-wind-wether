const LAT = 34.647;
const LON = 138.126;
const PLACE = "御前崎・池新田";

// ===== 通知設定 =====
const LOOKAHEAD_HOURS = 6;      // 通常チェックで何時間先まで見るか
const MORNING_HOUR = 8;         // 16時レポートで「翌朝」を何時までにするか

// ===== 閾値設定 =====
const WARNING_GUST = 15;        // 突風 m/s：強風警戒
const STOP_GUST = 20;           // 突風 m/s：停止推奨
const WARNING_WIND = 10;        // 平均風速 m/s：強風警戒
const STOP_WIND = 14;           // 平均風速 m/s：停止推奨

const mode = process.argv[2] || "check";
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!webhookUrl) {
  console.error("DISCORD_WEBHOOK_URL が設定されていません");
  process.exit(1);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowJstFakeDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function nowJstIsoMinute() {
  return nowJstFakeDate().toISOString().slice(0, 16);
}

function currentJstFloorHourIso() {
  const d = nowJstFakeDate();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 16);
}

function jstIsoAfterHoursFrom(startIso, hours) {
  const d = new Date(`${startIso}:00Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 16);
}

function todayJstDate() {
  return nowJstFakeDate().toISOString().slice(0, 10);
}

function addDaysToDateString(yyyyMMdd, days) {
  const d = new Date(`${yyyyMMdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function displayTime(iso) {
  if (!iso) return "--";
  const [date, time] = iso.split("T");
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)} ${time}`;
}

function degToDir(deg) {
  if (deg === null || deg === undefined) return "--";

  const dirs = [
    "北", "北北東", "北東", "東北東",
    "東", "東南東", "南東", "南南東",
    "南", "南南西", "南西", "西南西",
    "西", "西北西", "北西", "北北西"
  ];

  return dirs[Math.round(Number(deg) / 22.5) % 16];
}

function weatherText(code) {
  const map = {
    0: "快晴",
    1: "晴れ",
    2: "一部曇り",
    3: "曇り",
    45: "霧",
    48: "霧氷",
    51: "弱い霧雨",
    53: "霧雨",
    55: "強い霧雨",
    56: "弱い凍る霧雨",
    57: "強い凍る霧雨",
    61: "弱い雨",
    63: "雨",
    65: "強い雨",
    66: "弱い凍雨",
    67: "強い凍雨",
    71: "弱い雪",
    73: "雪",
    75: "強い雪",
    77: "雪粒",
    80: "弱いにわか雨",
    81: "にわか雨",
    82: "強いにわか雨",
    85: "弱いにわか雪",
    86: "強いにわか雪",
    95: "雷雨",
    96: "雷雨・弱い雹",
    99: "雷雨・強い雹"
  };

  return map[code] || `天気コード ${code}`;
}

function shortWeatherText(code) {
  const text = weatherText(code);

  const map = {
    "快晴": "快晴",
    "晴れ": "晴",
    "一部曇り": "一部曇",
    "曇り": "曇",
    "霧": "霧",
    "霧氷": "霧氷",
    "弱い霧雨": "弱霧雨",
    "霧雨": "霧雨",
    "強い霧雨": "強霧雨",
    "弱い雨": "弱雨",
    "雨": "雨",
    "強い雨": "強雨",
    "弱い凍雨": "弱凍雨",
    "強い凍雨": "強凍雨",
    "弱い雪": "弱雪",
    "雪": "雪",
    "強い雪": "強雪",
    "雪粒": "雪粒",
    "弱いにわか雨": "弱にわか雨",
    "にわか雨": "にわか雨",
    "強いにわか雨": "強にわか雨",
    "弱いにわか雪": "弱にわか雪",
    "強いにわか雪": "強にわか雪",
    "雷雨": "雷雨",
    "雷雨・弱い雹": "雷雨",
    "雷雨・強い雹": "強雷雨"
  };

  return map[text] || text;
}

function weatherIcon(code) {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

function maxOf(items, field) {
  let best = null;

  for (const item of items) {
    const value = item[field];

    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      continue;
    }

    if (!best || Number(value) > Number(best[field])) {
      best = item;
    }
  }

  return best;
}

function riskLabel(maxGust, maxWind) {
  if (maxGust >= STOP_GUST || maxWind >= STOP_WIND) {
    return "🟣 停止推奨";
  }

  if (maxGust >= WARNING_GUST || maxWind >= WARNING_WIND) {
    return "🔴 強風警戒";
  }

  if (maxGust >= 10 || maxWind >= 7) {
    return "🟡 風に注意";
  }

  return "🟢 通常";
}

async function fetchWeather() {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${LAT}` +
    `&longitude=${LON}` +
    "&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m" +
    "&wind_speed_unit=ms" +
    "&timezone=Asia%2FTokyo" +
    "&forecast_days=3";

  const maxRetries = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Open-Meteo取得試行 ${attempt}/${maxRetries}`);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "omaezaki-wind-alert/1.0"
        }
      });

      if (res.ok) {
        return await res.json();
      }

      console.log(`Open-Meteo status: ${res.status}`);

      // 一時的なエラーだけリトライ
      if (![429, 502, 503, 504].includes(res.status)) {
        throw new Error(`Open-Meteo API error: ${res.status}`);
      }

    } catch (err) {
      console.log(`Open-Meteo取得失敗: ${err.message}`);
    }

    if (attempt < maxRetries) {
      const waitMs = attempt * 5000;
      console.log(`${waitMs / 1000}秒待って再試行します`);
      await sleep(waitMs);
    }
  }

  throw new Error(`Open-Meteo API error: retry failed after ${maxRetries} attempts`);
}

function buildHourlyItems(data, startIso, endIso) {
  const h = data.hourly;
  const items = [];

  for (let i = 0; i < h.time.length; i++) {
    const time = h.time[i];

    if (time >= startIso && time <= endIso) {
      items.push({
        time,
        temp: h.temperature_2m[i],
        rainProb: h.precipitation_probability[i],
        rain: h.precipitation[i],
        code: h.weather_code[i],
        wind: h.wind_speed_10m[i],
        dir: h.wind_direction_10m[i],
        gust: h.wind_gusts_10m[i]
      });
    }
  }

  return items;
}

function summarize(items) {
  const peakGust = maxOf(items, "gust");
  const peakWind = maxOf(items, "wind");
  const peakRainProb = maxOf(items, "rainProb");
  const peakTemp = maxOf(items, "temp");

  return {
    peakGust,
    peakWind,
    peakRainProb,
    peakTemp,
    label: riskLabel(
      Number(peakGust?.gust ?? 0),
      Number(peakWind?.wind ?? 0)
    )
  };
}

function dateLabelForList(iso) {
  if (!iso) return "--";

  const [date] = iso.split("T");
  const [, m, d] = date.split("-");

  return `${Number(m)}/${Number(d)}`;
}

function timeLabelForList(iso) {
  if (!iso) return "--";

  const [, time] = iso.split("T");
  const [hh, mm] = time.split(":");

  return `${Number(hh)}:${mm}`;
}

function buildHourlyList(items) {
  const lines = [];
  let currentDateLabel = "";

  for (const item of items) {
    const dateLabel = dateLabelForList(item.time);

    // 日付が変わったタイミングだけ日付行を入れる
    if (dateLabel !== currentDateLabel) {
      lines.push(`${dateLabel}`);
      currentDateLabel = dateLabel;
    }

    const timeLabel = timeLabelForList(item.time);
    const weather = shortWeatherText(item.code);

    lines.push(`${timeLabel} ${weather}`);
    lines.push(`　　気温${fmt(item.temp)}℃ / 降水${fmt(item.rainProb, 0)}%`);
    lines.push(`　　${fmt(item.wind)}m/s（突風${fmt(item.gust)}m/s）`);
    lines.push("");
  }

  // 最後の空行を削除
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function buildMessage({
  title,
  startIso,
  endIso,
  items,
  force,
  includeHourlyList = false
}) {
  const s = summarize(items);
  const peak = s.peakGust || s.peakWind || items[0];
  const code = peak?.code;
  const icon = weatherIcon(code);
  const text = weatherText(code);

  const lines = [
    `${title}`,
    `地点：${PLACE}`,
    `対象：${displayTime(startIso)} 〜 ${displayTime(endIso)}`,
    `判定：${s.label}`,
    `最大突風：${fmt(s.peakGust?.gust)} m/s（${displayTime(s.peakGust?.time)}・${degToDir(s.peakGust?.dir)}）`,
    `最大風速：${fmt(s.peakWind?.wind)} m/s（${displayTime(s.peakWind?.time)}・${degToDir(s.peakWind?.dir)}）`,
    `最高気温：${fmt(s.peakTemp?.temp)} ℃（${displayTime(s.peakTemp?.time)}）`,
    `最大降水確率：${fmt(s.peakRainProb?.rainProb, 0)} %（${displayTime(s.peakRainProb?.time)}）`,
    `ピーク時の天気：${icon} ${text}`,
    `取得：${displayTime(nowJstIsoMinute())}`,
    force ? "" : "※閾値を超えたため通知しました。"
  ].filter(Boolean);

  if (includeHourlyList) {
    lines.push("");
    lines.push("【時間別一覧】");
    lines.push(...buildHourlyList(items));
  }

  return lines.join("\n");
}

function splitDiscordContent(content, limit = 1800) {
  if (content.length <= limit) return [content];

  const chunks = [];
  const lines = content.split("\n");
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function postDiscord(content) {
  const chunks = splitDiscordContent(content);

  for (const chunk of chunks) {
    const url = new URL(webhookUrl);
    url.searchParams.set("wait", "true");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "御前崎 風予報",
        content: chunk,
        allowed_mentions: {
          parse: []
        }
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord webhook error: ${res.status} ${body}`);
    }
  }
}

async function main() {
  const data = await fetchWeather();

  let startIso;
  let endIso;
  let title;
  let force = false;

  if (mode === "daily") {
    const today = todayJstDate();
    const tomorrow = addDaysToDateString(today, 1);

    startIso = `${today}T16:00`;
    endIso = `${tomorrow}T${pad(MORNING_HOUR)}:00`;
    title = "📋 16時定時レポート：夕方〜翌朝の風予報";
    force = true;
  } else if (mode === "test") {
    startIso = currentJstFloorHourIso();
    endIso = jstIsoAfterHoursFrom(startIso, LOOKAHEAD_HOURS);
    title = "🧪 テスト通知：今後の風予報";
    force = true;
  } else {
    startIso = currentJstFloorHourIso();
    endIso = jstIsoAfterHoursFrom(startIso, LOOKAHEAD_HOURS);
    title = `🚨 強風アラート：今後${LOOKAHEAD_HOURS}時間の最大値`;
  }

  const items = buildHourlyItems(data, startIso, endIso);

  if (items.length === 0) {
    throw new Error("対象時間帯の予報データがありません");
  }

  const s = summarize(items);

  const shouldAlert =
    force ||
    Number(s.peakGust?.gust ?? 0) >= WARNING_GUST ||
    Number(s.peakWind?.wind ?? 0) >= WARNING_WIND;

  // 16時レポートのときだけ時間別一覧を付ける
  const includeHourlyList = mode === "daily";

  if (!shouldAlert) {
    console.log("閾値未満のためDiscord通知なし");
    console.log(buildMessage({
      title,
      startIso,
      endIso,
      items,
      force: true,
      includeHourlyList
    }));
    return;
  }

  const message = buildMessage({
    title,
    startIso,
    endIso,
    items,
    force,
    includeHourlyList
  });

  await postDiscord(message);
  console.log("Discordへ通知しました");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});