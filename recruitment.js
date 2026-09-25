const SUPABASE_URL = "https://xncgytnnekaytqmypdqv.supabase.co";
const SUPABASE_KEY = "sb_publishable_UiLB55XsY_iD9m_wUNlSwA_UEjBa5fR";

const recruitmentSupabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

async function getRecruitingDataStartDate() {
  const { data, error } = await recruitmentSupabase
    .from("recruiting_settings")
    .select("data_start_date")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("Recruiting start date error:", error);
    return null;
  }

  return data?.data_start_date || null;
}

function getAverage(values) {
  if (!values.length) return 0;

  return (
    values.reduce((sum, value) => sum + Number(value || 0), 0) /
    values.length
  );
}

function parseMaybeJson(value) {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }

  return value;
}

function getPayload(round) {
  return (
    parseMaybeJson(round.round_payload) ||
    parseMaybeJson(round.roundPayload) ||
    null
  );
}

function getRoundHoles(round) {
  const payload = getPayload(round);

  if (payload && Array.isArray(payload.holes)) {
    return payload.holes;
  }

  const holesJson = parseMaybeJson(round.holes_json);

  if (Array.isArray(holesJson)) {
    return holesJson;
  }

  return [];
}

function dedupeRounds(rounds) {
  const seen = new Set();

  return rounds.filter(round => {
    const key = [
      round.round_date || "",
      String(round.course_name || "").trim().toLowerCase(),
      Number(round.total_score || 0)
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function roundEndedEarly(round) {
  const payload = getPayload(round);
  return Boolean(payload?.roundEndedEarly);
}

function isOrdinaryNineHoleRound(round) {
  const payload = getPayload(round);
  const details = payload?.details || payload?.roundDetails || {};

  const roundLength = Number(
    details.roundLength || payload?.roundLength || round.round_length || 0
  );

  // Explicitly planned 9-hole rounds are not recruiting rounds.
  if (roundLength === 9) return true;

  // Legacy rounds without a round-length field remain eligible.
  return false;
}

function isRecruitingTournamentRound(round) {
  const payload = getPayload(round);
  const details = payload?.details || payload?.roundDetails || {};

  const roundType = String(
    round?.round_type ||
    details?.roundType ||
    payload?.roundType ||
    ""
  )
    .trim()
    .toLowerCase();

  // These are the competition types intended for the public
  // recruiting scoring profile.
  return (
    roundType === "jr pga tournament" ||
    roundType === "high school tournament" ||
    roundType === "ajga tournament"
  );
}

function getPartialRoundNote(round) {
  if (!roundEndedEarly(round)) return "";

  const payload = getPayload(round);

  // Future Phase 3 rounds can supply their actual reason.
  const storedReason =
    payload?.endReason ||
    payload?.roundEndReason ||
    payload?.endedEarlyReason ||
    "";

  if (storedReason) {
    return `— ${storedReason}`;
  }

  // Legacy fallback for the known Overland partial round.
  const courseName = String(round.course_name || "").toLowerCase();

  if (courseName.includes("overland")) {
    return "— Called after 9 holes due to weather";
  }

  return "— Round ended early";
}

function getFirPct(round) {
  const holes = getRoundHoles(round);

  const firOpportunities = holes.filter(hole =>
    hole &&
    hole.saved &&
    Number(hole.par || 0) >= 4
  );

  if (firOpportunities.length) {
    const fairwaysHit = firOpportunities.filter(
      hole => hole.fir === true
    ).length;

    return (fairwaysHit / firOpportunities.length) * 100;
  }

  return Number(round.fir_pct || 0);
}

function getGirPct(round) {
  const holes = getRoundHoles(round);

  const savedHoles = holes.filter(
    hole => hole && hole.saved
  );

  if (savedHoles.length) {
    const greensHit = savedHoles.filter(
      hole => hole.gir === true
    ).length;

    return (greensHit / savedHoles.length) * 100;
  }

  return Number(round.gir_pct || 0);
}

function getPuttsPerGir(rounds) {
  let girHoleCount = 0;
  let puttsOnGirHoles = 0;

  rounds.forEach(round => {
    const holes = getRoundHoles(round);

    holes.forEach(hole => {
      if (!hole || !hole.saved || hole.gir !== true) return;

      const putts = Number(hole.putts);

      if (Number.isFinite(putts)) {
        girHoleCount += 1;
        puttsOnGirHoles += putts;
      }
    });
  });

  if (!girHoleCount) return null;

  return puttsOnGirHoles / girHoleCount;
}

function getRoundPuttsPerGir(round) {
  const holes = getRoundHoles(round);

  let girHoleCount = 0;
  let puttsOnGirHoles = 0;

  holes.forEach(hole => {
    if (!hole || !hole.saved || hole.gir !== true) return;

    const putts = Number(hole.putts);

    if (Number.isFinite(putts)) {
      girHoleCount += 1;
      puttsOnGirHoles += putts;
    }
  });

  if (!girHoleCount) return null;

  return puttsOnGirHoles / girHoleCount;
}

function formatVsPar(value) {
  if (value > 0) return `+${value.toFixed(1)}`;
  if (value < 0) return value.toFixed(1);
  return "E";
}


// ===== ESTIMATED HANDICAP INDEX =====

function calculateEstimatedHandicapIndex(rounds) {
  // Handicap calculation uses the most recent 20 eligible rounds,
  // independent of the 5 / 10 / 15 / 20 display selector.
  const eligibleRounds = rounds
    .filter(round => {
      const score = Number(round.total_score);
      const rating = Number(round.tee_rating);
      const slope = Number(round.tee_slope);

      return (
        round.handicap_eligible !== false &&
        Number.isFinite(score) &&
        score > 0 &&
        Number.isFinite(rating) &&
        rating > 0 &&
        Number.isFinite(slope) &&
        slope >= 55 &&
        slope <= 155
      );
    })
    .slice(-20);

  if (eligibleRounds.length < 3) {
    return null;
  }

  const differentials = eligibleRounds
    .map(round => {
      const score = Number(round.total_score);
      const rating = Number(round.tee_rating);
      const slope = Number(round.tee_slope);

      return (113 / slope) * (score - rating);
    })
    .sort((a, b) => a - b);

  const count = differentials.length;

  let numberToUse = 0;
  let adjustment = 0;

  if (count === 3) {
    numberToUse = 1;
    adjustment = -2.0;
  } else if (count === 4) {
    numberToUse = 1;
    adjustment = -1.0;
  } else if (count === 5) {
    numberToUse = 1;
  } else if (count === 6) {
    numberToUse = 2;
    adjustment = -1.0;
  } else if (count <= 8) {
    numberToUse = 2;
  } else if (count <= 11) {
    numberToUse = 3;
  } else if (count <= 14) {
    numberToUse = 4;
  } else if (count <= 16) {
    numberToUse = 5;
  } else if (count <= 18) {
    numberToUse = 6;
  } else if (count === 19) {
    numberToUse = 7;
  } else {
    numberToUse = 8;
  }

  const usedDifferentials = differentials.slice(0, numberToUse);


console.log("===== HANDICAP DIFFERENTIAL CHECK =====");

eligibleRounds.forEach(round => {
  const score = Number(round.total_score);
  const rating = Number(round.tee_rating);
  const slope = Number(round.tee_slope);

  const differential =
    (113 / slope) * (score - rating);

  console.log(
    `${round.round_date} | ${round.course_name} | Type ${round.round_type || "--"} | Score ${score} | Rating ${rating} | Slope ${slope} | Differential ${differential.toFixed(1)}`
  );
});


  const average =
    usedDifferentials.reduce((sum, diff) => sum + diff, 0) /
    usedDifferentials.length;

  return Number((average + adjustment).toFixed(1));
}


function updateRecruitingMetrics(rounds, handicapRounds) {
  const scoringAvg = getAverage(
    rounds.map(round => Number(round.total_score || 0))
  );

  const gir = getAverage(
    rounds.map(round => getGirPct(round))
  );

  const fir = getAverage(
    rounds.map(round => getFirPct(round))
  );

  const vsPar = getAverage(
    rounds.map(round => Number(round.vs_par || 0))
  );

  const putts = getAverage(
    rounds.map(round => Number(round.total_putts || 0))
  );

  const puttsPerGir = getPuttsPerGir(rounds);

  document.getElementById("recentScoringAvg").textContent =
  rounds.length ? scoringAvg.toFixed(1) : "--";

   const heroScoringAvg = document.getElementById("heroRecentScoringAvg");

if (heroScoringAvg) {
  heroScoringAvg.textContent =
    rounds.length ? scoringAvg.toFixed(1) : "--";
}

if (glanceScoringAvg) {
  glanceScoringAvg.textContent =
    rounds.length ? scoringAvg.toFixed(1) : "--";
}

const estimatedHandicap =
  calculateEstimatedHandicapIndex(handicapRounds);

const heroHandicap = document.getElementById("heroHandicap");

if (heroHandicap) {
  heroHandicap.textContent =
    estimatedHandicap === null
      ? "--"
      : estimatedHandicap.toFixed(1);
}

const glanceHandicap = document.getElementById("glanceHandicap");

if (glanceHandicap) {
  glanceHandicap.textContent =
    estimatedHandicap === null
      ? "--"
      : estimatedHandicap.toFixed(1);
}

  document.getElementById("recentGir").textContent =
    `${Math.round(gir)}%`;

  document.getElementById("recentFir").textContent =
    `${Math.round(fir)}%`;

  document.getElementById("recentVsPar").textContent =
    formatVsPar(vsPar);

  document.getElementById("recentPutts").textContent =
    putts.toFixed(1);

  document.getElementById("recentPuttsGir").textContent =
    puttsPerGir !== null
      ? puttsPerGir.toFixed(2)
      : "--";

  console.log("RECRUITING LAST 10:", rounds);

  console.log("RECRUITING METRICS:", {
    scoringAvg,
    gir,
    fir,
    vsPar,
    putts,
    puttsPerGir
  });
}

function showTrendRoundInfo(round) {
  const info = document.getElementById("trendRoundInfo");
  if (!info || !round) return;

  const score = Number(round.total_score || 0);
  const vsPar = Number(round.vs_par || 0);
  const fir = getFirPct(round);
  const gir = getGirPct(round);
  const putts = Number(round.total_putts || 0);
  const puttsPerGir = getRoundPuttsPerGir(round);
  const yardage = round.tee_yardage || "--";
  const rating = round.tee_rating || "--";
  const slope = round.tee_slope || "--";
  const rawRoundType = String(
  round.round_type ||
  getPayload(round)?.details?.roundType ||
  getPayload(round)?.roundDetails?.roundType ||
  getPayload(round)?.roundType ||
  ""
).trim();

const roundTypeDisplay =
  rawRoundType.toLowerCase() === "high school tournament"
    ? "CHSAA High School Tournament"
    : rawRoundType;

  const vsParText =
    vsPar > 0 ? `+${vsPar}` :
    vsPar < 0 ? `${vsPar}` :
    "E";

  info.hidden = false;
  openTrendDetailsModal();

info.innerHTML = `
  <div class="trend-info-heading">
    <strong class="trend-round-date">
      ${round.round_date || "Date not listed"}
    </strong>

    ${roundTypeDisplay
      ? `<div class="trend-round-type">${roundTypeDisplay}</div>`
      : ""}

    <span class="trend-course-name">
      ${round.course_name || "Course not listed"}
      ${roundEndedEarly(round)
        ? ` <em class="partial-round-note">${getPartialRoundNote(round)}</em>`
        : ""}
    </span>

    <small class="trend-course-meta">
      ${yardage} yards · Rating ${rating} · Slope ${slope}
    </small>
  </div>

  <div class="trend-info-stats">
    <div><span>Score</span><strong>${score || "--"}</strong></div>
    <div><span>To Par</span><strong>${vsParText}</strong></div>
    <div><span>FIR</span><strong>${Math.round(fir)}%</strong></div>
    <div><span>GIR</span><strong>${Math.round(gir)}%</strong></div>
    <div><span>Putts</span><strong>${putts || "--"}</strong></div>
    <div>
      <span>Putts / GIR</span>
      <strong>${puttsPerGir !== null ? puttsPerGir.toFixed(2) : "--"}</strong>
    </div>
  </div>
`;
}

function drawRecruitingTrend(rounds) {
  const svg = document.getElementById("recruitingTrendChart");
  if (!svg) return;

  if (!rounds.length) {
    const width = 520;
    const height = 220;
    const left = 42;
    const right = 18;
    const top = 24;
    const bottom = 38;
    const chartBottom = height - bottom;
    const chartRight = width - right;

    let gridHtml = "";

    [70, 75, 80, 85, 90].forEach((score, index) => {
      const y = top + index * ((chartBottom - top) / 4);

      gridHtml += `
        <line
          x1="${left}" y1="${y}"
          x2="${chartRight}" y2="${y}"
          class="trend-grid-line"
        />
        <text
          x="${left - 9}" y="${y + 4}"
          text-anchor="end"
          class="trend-axis-label"
        >${score}</text>
      `;
    });

    svg.innerHTML = `
      ${gridHtml}
      <line
        x1="${left}" y1="${top}"
        x2="${left}" y2="${chartBottom}"
        class="trend-grid-line"
      />
      <line
        x1="${left}" y1="${chartBottom}"
        x2="${chartRight}" y2="${chartBottom}"
        class="trend-grid-line"
      />
      <text
        x="${width / 2}"
        y="${height / 2 - 5}"
        text-anchor="middle"
        class="trend-axis-label"
        style="font-size: 13px; font-weight: 600;"
      >No qualifying rounds yet</text>
      <text
        x="${width / 2}"
        y="${height / 2 + 13}"
        text-anchor="middle"
        class="trend-axis-label"
        style="font-size: 10px;"
      >New Day 1: September 8, 2026</text>
    `;

    const trendSummary = document.getElementById("trendSummary");
    if (trendSummary) {
      trendSummary.textContent = "Awaiting first qualifying round";
    }

    return;
  }

  // Only full rounds determine the scoring scale and scoring line.
  const completedRounds = rounds.filter(
    round =>
      !roundEndedEarly(round) &&
      Number(round.total_score || 0) > 0
  );

  if (!completedRounds.length) return;

  const completedScores = completedRounds.map(
    round => Number(round.total_score || 0)
  );

  const width = 520;
  const height = 220;

  const padding = {
    top: 24,
    right: 18,
    bottom: 38,
    left: 42
  };

  const chartWidth =
    width - padding.left - padding.right;

  const chartHeight =
    height - padding.top - padding.bottom;

  const rawMin = Math.min(...completedScores);
  const rawMax = Math.max(...completedScores);

  const minScore = Math.floor(rawMin) - 2;
  const maxScore = Math.ceil(rawMax) + 2;
  const scoreRange = Math.max(maxScore - minScore, 1);

  let gridHtml = "";

  for (
    let value = minScore;
    value <= maxScore;
    value += 2
  ) {
    const y =
      padding.top +
      ((maxScore - value) / scoreRange) *
        chartHeight;

    gridHtml += `
      <line
        x1="${padding.left}"
        y1="${y}"
        x2="${width - padding.right}"
        y2="${y}"
        class="trend-grid-line"
      />

      <text
        x="${padding.left - 9}"
        y="${y + 4}"
        text-anchor="end"
        class="trend-axis-label"
      >${value}</text>
    `;
  }

  const completedPoints = [];

  let pointHtml = "";

  rounds.forEach((round, index) => {
    const x =
      padding.left +
      (index / Math.max(rounds.length - 1, 1)) *
        chartWidth;

    if (roundEndedEarly(round)) {
      // Partial rounds get a contextual marker only.
      const y = padding.top + chartHeight * 0.82;
      const size = 7;

      pointHtml += `
      <line
  x1="${x}"
  y1="${padding.top}"
  x2="${x}"
  y2="${padding.top + chartHeight}"
  class="trend-partial-line"
/>
        <polygon
          points="
            ${x},${y - size}
            ${x + size},${y}
            ${x},${y + size}
            ${x - size},${y}
          "
          class="trend-partial-point"
          data-round-index="${index}"
          tabindex="0"
          role="button"
          aria-label="View partial round details"
        />
      `;

      return;
    }

    const score = Number(round.total_score || 0);
    if (!score) return;

    const pointClass =
  score >= 68 && score <= 78
    ? "trend-point trend-point-good"
    : "trend-point";

    const y =
      padding.top +
      ((maxScore - score) / scoreRange) *
        chartHeight;

    completedPoints.push({ x, y });

    pointHtml += `
    <circle
        cx="${x}"
        cy="${y}"
        r="18"
        class="trend-point-hit"
        data-round-index="${index}"
        tabindex="0"
        role="button"
        aria-label="View round details"
    />

      <circle
        cx="${x}"
        cy="${y}"
        r="7"
        class="${pointClass}"
        data-round-index="${index}"
        tabindex="0"
        role="button"
        aria-label="View round details"
      />
    `;
  });

  const polylinePoints = completedPoints
    .map(point => `${point.x},${point.y}`)
    .join(" ");

svg.innerHTML = `
  ${gridHtml}

  <polyline
    points="${polylinePoints}"
    class="trend-score-line"
  />

  ${pointHtml}
`;

  svg
    svg.querySelectorAll(".trend-point-hit, .trend-partial-point")
    .forEach(pointEl => {
      const index = Number(pointEl.dataset.roundIndex);

      pointEl.addEventListener("click", () => {
        showTrendRoundInfo(rounds[index]);
      });

      pointEl.addEventListener("keydown", event => {
        if (
          event.key === "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          showTrendRoundInfo(rounds[index]);
        }
      });
    });

  const trendSummary =
    document.getElementById("trendSummary");

  if (
    trendSummary &&
    completedScores.length >= 2
  ) {
    const first = completedScores[0];
    const last =
      completedScores[completedScores.length - 1];

    const change = last - first;

    if (change < 0) {
      trendSummary.innerHTML =
        `<strong>Down ${Math.abs(change).toFixed(0)} strokes</strong> <br>from first to most recent round`;
    } else if (change > 0) {
      trendSummary.textContent =
        `Up ${change.toFixed(0)} strokes from first to most recent round`;
    } else {
      trendSummary.textContent =
        "No change from first to most recent round";
    }
  }
}


async function loadRecruitmentData() {
  console.log("Recruitment page: loading live Stracker data...");

  const recruitingStartDate =
    await getRecruitingDataStartDate();

  console.log(
    "RECRUITING DATA START DATE:",
    recruitingStartDate
  );

  const { data: v1Data, error: v1Error } =
    await recruitmentSupabase
      .from("completed_rounds")
      .select("*")
      .order("round_date", { ascending: true });

  const { data: p2Data, error: p2Error } =
    await recruitmentSupabase
      .from("completed_rounds_p2")
      .select("*")
      .order("round_date", { ascending: true });

  if (v1Error) {
    console.error("V1 recruiting data error:", v1Error);
  }

  if (p2Error) {
    console.error("P2 recruiting data error:", p2Error);
  }

  const allRounds = [
    ...(v1Data || []).map(round => ({
      ...round,
      source: "V1"
    })),

    ...(p2Data || []).map(round => ({
      ...round,
      source: "P2"
    }))
  ];

  allRounds.sort(
    (a, b) =>
      new Date(a.round_date) -
      new Date(b.round_date)
  );

  // Recruiting scoring profile uses full rounds only.
// Recruiting scoring profile:
// - full rounds only
// - planned 9-hole rounds excluded
// - P2 rounds must be recognized tournament rounds
// - legacy V1 rounds remain eligible so older history is preserved
const qualifyingRounds = dedupeRounds(allRounds).filter(round => {
  const hasValidScore =
    Number(round.total_score || 0) > 0;

  const isFullRound =
    !roundEndedEarly(round) &&
    !isOrdinaryNineHoleRound(round);

  const isLegacyV1 =
    round.source === "V1";

  const isEligibleTournament =
    isRecruitingTournamentRound(round);

  const roundDate =
    String(round.round_date || "").slice(0, 10);

  const isOnOrAfterRecruitingStart =
    !recruitingStartDate ||
    (
      roundDate &&
      roundDate >= recruitingStartDate
    );

  return (
    hasValidScore &&
    isFullRound &&
    isOnOrAfterRecruitingStart &&
    (
      isLegacyV1 ||
      isEligibleTournament
    )
  );
});

const last10 = qualifyingRounds.slice(-8);
const handicapRounds = qualifyingRounds.slice(-20);


console.log("HANDICAP ROUND COUNT:", handicapRounds.length);

console.table(
  handicapRounds.map(round => ({
    date: round.round_date,
    course: round.course_name,
    score: round.total_score,
    rating: round.tee_rating,
    slope: round.tee_slope,
    source: round.source
  }))
);

  const firstLast10Date = last10.length
  ? new Date(last10[0].round_date)
  : null;

const lastLast10Date = last10.length
  ? new Date(last10[last10.length - 1].round_date)
  : null;

const partialRoundsInWindow = dedupeRounds(allRounds).filter(round => {
  if (!roundEndedEarly(round)) return false;
  if (isOrdinaryNineHoleRound(round)) return false;
  if (!firstLast10Date || !lastLast10Date) return false;

const roundDate = new Date(round.round_date);

const roundDateString =
  String(round.round_date || "").slice(0, 10);

if (
  recruitingStartDate &&
  roundDateString < recruitingStartDate
) {
  return false;
}

return (
  roundDate >= firstLast10Date &&
  roundDate <= lastLast10Date
);
});

const chartRounds = [
  ...last10,
  ...partialRoundsInWindow
].sort(
  (a, b) =>
    new Date(a.round_date) -
    new Date(b.round_date)
);

  console.log(
    "TOTAL RECRUITING ROUNDS:",
    allRounds.length
  );

  console.log(
    "QUALIFYING FULL ROUNDS:",
    qualifyingRounds.length
  );

  updateRecruitingMetrics(last10, handicapRounds);
  drawRecruitingTrend(chartRounds);
}

function setupHandicapInfoModal() {
  const openBtn = document.getElementById("handicapInfoBtn");
  const modal = document.getElementById("handicapInfoModal");
  const closeBtn = document.getElementById("handicapInfoCloseBtn");
  const backdrop = modal?.querySelector("[data-handicap-close]");

  if (!openBtn || !modal || !closeBtn) return;

  const openModal = () => {
    modal.hidden = false;
    closeBtn.focus();
  };

  const closeModal = () => {
    modal.hidden = true;
    openBtn.focus();
  };

  openBtn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);

  if (backdrop) {
    backdrop.addEventListener("click", closeModal);
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !modal.hidden) {
      closeModal();
    }
  });
}

function setupMobileMenu() {
  const menuBtn = document.getElementById("mobileMenuBtn");
  const mobileMenu = document.getElementById("mobileMenu");

  if (!menuBtn || !mobileMenu) return;

  const closeMenu = () => {
    mobileMenu.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.setAttribute("aria-label", "Open main menu");
  };

  const openMenu = () => {
    mobileMenu.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    menuBtn.setAttribute("aria-label", "Close main menu");
  };

  menuBtn.addEventListener("click", () => {
    if (mobileMenu.hidden) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  mobileMenu.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", closeMenu);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !mobileMenu.hidden) {
      closeMenu();
      menuBtn.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) {
      closeMenu();
    }
  });
}

function setupFirstGlanceCardScroll() {
  const trendCard = document.querySelector(".first-glance .trend-card");
  const videoCard = document.querySelector(".first-glance #video");
  const statStrip = document.querySelector(".stat-strip");
  const header = document.querySelector(".site-header");

  if (!trendCard || !videoCard || !statStrip) return;

  const scrollToFirstGlance = event => {
    if (window.innerWidth < 981) return;

    // Preserve existing interactive controls.
    if (
      event.target.closest(
        "a, button, [role='button'], .trend-point-hit, .trend-partial-point"
      )
    ) {
      return;
    }

    const headerHeight = header ? header.offsetHeight : 0;

    // Leave a small slice of the hero visible below the sticky header.
    const heroReveal = 55;

    const targetY =
      statStrip.getBoundingClientRect().top +
      window.pageYOffset -
      headerHeight -
      heroReveal;

    window.scrollTo({
      top: targetY,
      behavior: "smooth"
    });
  };

  trendCard.addEventListener("click", scrollToFirstGlance);
  videoCard.addEventListener("click", scrollToFirstGlance);
}

window.addEventListener("load", loadRecruitmentData);
window.addEventListener("load", setupHandicapInfoModal);
window.addEventListener("load", setupMobileMenu);
window.addEventListener("load", setupFirstGlanceCardScroll);
// Preview-only round details overlay. Existing chart data and calculations are preserved.
function openTrendDetailsModal() {
  const modal = document.getElementById("trendDetailsModal");
  if (!modal) return;
  modal.hidden = false;
  document.getElementById("trendDetailsCloseBtn")?.focus();
}
function closeTrendDetailsModal() {
  const modal = document.getElementById("trendDetailsModal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.getElementById("trendRoundInfo").hidden = true;
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("trendDetailsCloseBtn")
    ?.addEventListener("click", closeTrendDetailsModal);

  document.querySelector("[data-trend-close]")
    ?.addEventListener("click", closeTrendDetailsModal);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeTrendDetailsModal();
    }
  });
});
