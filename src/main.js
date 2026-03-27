const dataUrl = "data/agg_parking_v1.json";

const els = {
  dataSourceLabel: document.getElementById("dataSourceLabel"),
  provinceSelect: document.getElementById("provinceSelect"),
  violationSelect: document.getElementById("violationSelect"),
  colorBySelect: document.getElementById("colorBySelect"),
  resetBtn: document.getElementById("resetBtn"),
  streetName: document.getElementById("streetName"),
  streetTickets: document.getElementById("streetTickets"),
  streetTopViolation: document.getElementById("streetTopViolation"),
  streetAvgFine: document.getElementById("streetAvgFine"),
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function abbreviateViolation(s) {
  if (!s) return "";
  return s.length > 22 ? s.slice(0, 19) + "…" : s;
}

const hourDomain = d3.range(0, 24);

let dataset = null;
let violationsAll = [];

const state = {
  provinceGroup: "ON",
  violation: "All",
  colorBy: "Violation", // "Violation" | "AvgFine"

  streetSelected: null,

  // Manual selection:
  brushMinHour: 0,
  brushMaxHour: 23,
};

// Tooltip (HTML overlay)
const tooltip = d3
  .select("body")
  .append("div")
  .attr("class", "tooltip tooltip--hide")
  .style("position", "absolute")
  .style("background", "rgba(15, 23, 48, 0.95)")
  .style("border", "1px solid rgba(255, 255, 255, 0.16)")
  .style("border-radius", "10px")
  .style("padding", "10px 12px")
  .style("pointer-events", "none")
  .style("opacity", 0);

function tooltipShow(html, x, y) {
  tooltip.html(html).style("left", `${x + 14}px`).style("top", `${y + 14}px`).style("opacity", 1);
}

function tooltipMove(x, y) {
  tooltip.style("left", `${x + 14}px`).style("top", `${y + 14}px`);
}

function tooltipHide() {
  tooltip.style("opacity", 0);
}

// Indices for fast lookups
let streetIndex = new Map(); // key: `${prov}|${street}|${hour}|${viol}` -> {count,fineSum}
let globalIndex = new Map(); // key: `${prov}|${hour}|${viol}` -> {count,fineSum}
let streetTotalsIndex = new Map(); // key: `${prov}|${street}` -> {count,fineSum}

function idxStreet(prov, street, hour, viol) {
  return `${prov}|${street}|${hour}|${viol}`;
}
function idxGlobal(prov, hour, viol) {
  return `${prov}|${hour}|${viol}`;
}
function idxStreetTotal(prov, street) {
  return `${prov}|${street}`;
}

function getHourSet() {
  const minH = clamp(Math.min(state.brushMinHour, state.brushMaxHour), 0, 23);
  const maxH = clamp(Math.max(state.brushMinHour, state.brushMaxHour), 0, 23);
  const hourSet = [];
  for (let h = minH; h <= maxH; h++) {
    hourSet.push(h);
  }
  return hourSet;
}

function getViolationCategories() {
  const vio = violationsAll; // top violations + Other (no All)
  if (state.violation === "All") return vio;
  return [state.violation];
}

function computeStreetMetrics(street, hourSet, provinceGroupsToUse) {
  let totalCount = 0;
  let totalFine = 0;
  let commonViolation = null;
  let commonCount = -1;
  const violationTotals = new Map();
  const violations = getViolationCategories();

  for (const prov of provinceGroupsToUse) {
    for (const h of hourSet) {
      for (const viol of violations) {
        const rec = streetIndex.get(idxStreet(prov, street, h, viol));
        if (!rec) continue;
        totalCount += rec.count;
        totalFine += rec.fineSum;
        violationTotals.set(viol, (violationTotals.get(viol) ?? 0) + rec.count);
      }
    }
  }

  for (const [viol, count] of violationTotals.entries()) {
    if (count > commonCount) {
      commonCount = count;
      commonViolation = viol;
    }
  }

  const avgFine = totalCount > 0 ? totalFine / totalCount : 0;
  return { totalCount, avgFine, commonViolation };
}

function getProvinceGroupsSelected() {
  // The UI currently uses "provinceGroup" values: ON | QC | Other.
  // We also keep an "All" behavior by summing all 3 groups.
  if (state.provinceGroup === "All") return ["ON", "QC", "Other"];
  return [state.provinceGroup];
}

function computeTimeSeriesCounts() {
  const hourSetSelected = getHourSet();
  const provinceGroupsToUse = getProvinceGroupsSelected();
  const violCats = getViolationCategories();

  const counts = new Array(24).fill(0);

  const sumForHourStreet = (hour) => {
    let sum = 0;
    for (const prov of provinceGroupsToUse) {
      for (const viol of violCats) {
        const rec = streetIndex.get(idxStreet(prov, state.streetSelected, hour, viol));
        if (rec) sum += rec.count;
      }
    }
    return sum;
  };

  const sumForHourGlobal = (hour) => {
    let sum = 0;
    for (const prov of provinceGroupsToUse) {
      for (const viol of violCats) {
        const rec = globalIndex.get(idxGlobal(prov, hour, viol));
        if (rec) sum += rec.count;
      }
    }
    return sum;
  };

  for (const h of hourDomain) {
    counts[h] = state.streetSelected ? sumForHourStreet(h) : sumForHourGlobal(h);
  }

  return { counts, hourSetSelected: new Set(hourSetSelected) };
}

function computeViolationBars() {
  const provinceGroupsToUse = getProvinceGroupsSelected();
  const hourSet = getHourSet();

  const bars = violationsAll.map((viol) => {
    let count = 0;
    let fineSum = 0;
    for (const prov of provinceGroupsToUse) {
      for (const h of hourSet) {
        if (state.streetSelected) {
          const rec = streetIndex.get(idxStreet(prov, state.streetSelected, h, viol));
          if (!rec) continue;
          count += rec.count;
          fineSum += rec.fineSum;
        } else {
          const rec = globalIndex.get(idxGlobal(prov, h, viol));
          if (!rec) continue;
          count += rec.count;
          fineSum += rec.fineSum;
        }
      }
    }
    return { violation: viol, count, fineSum, avgFine: count ? fineSum / count : 0 };
  });

  // If user selected a specific violation filter, show just that.
  if (state.violation !== "All") {
    return bars.filter((b) => b.violation === state.violation);
  }

  // Otherwise show top N by count for readability in the compact panel.
  bars.sort((a, b) => b.count - a.count);
  return bars.slice(0, Math.min(5, bars.length));
}

function setupControls() {
  const provinces = ["All", "ON", "QC", "Other"];
  els.provinceSelect.innerHTML = provinces.map((p) => `<option value="${p}">${p}</option>`).join("");
  els.provinceSelect.value = state.provinceGroup;

  const violationOptions = ["All", ...violationsAll];
  els.violationSelect.innerHTML = violationOptions
    .map((v) => `<option value="${v}">${abbreviateViolation(v)}</option>`)
    .join("");
  els.violationSelect.value = state.violation;

  els.colorBySelect.innerHTML = [
    `<option value="Violation">Violation</option>`,
    `<option value="AvgFine">Avg Fine</option>`,
  ].join("");
  els.colorBySelect.value = state.colorBy;
}

function resizeSVG(svg, width, height) {
  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("preserveAspectRatio", "xMidYMid meet");
}

function render() {
  if (!dataset) return;

  // Determine hour selection set.
  const hourSet = getHourSet();
  const provinceGroupsToUse = getProvinceGroupsSelected();

  // Update Map
  updateMap(hourSet, provinceGroupsToUse);

  // Update Time chart
  updateTimeChart();

  // Update Violation chart
  updateViolationChart();

  // Update details
  updateDetails();
}

let mapMetricsByStreet = new Map(); // street -> {totalCount, avgFine, commonViolation}

// ---------- Map view ----------
const mapLayout = { width: 740, height: 430, margin: 12 };
let mapSvg, mapGZoom, mapG, mapCircles;

function updateMap(hourSet, provinceGroupsToUse) {
  if (!mapSvg) return;

  // Compute per-street metrics for current selection.
  mapMetricsByStreet = new Map();

  let maxCount = 0;
  for (const street of dataset.topStreets) {
    const metrics = computeStreetMetrics(street, hourSet, provinceGroupsToUse);
    mapMetricsByStreet.set(street, metrics);
    maxCount = Math.max(maxCount, metrics.totalCount);
  }

  const countScale = d3
    .scaleSqrt()
    .domain([0, Math.max(1, maxCount)])
    .range([6, 38]);

  // Color scale.
  let fillScale = null;
  let fineScale = null;
  const violPalette = d3.schemeTableau10.concat(d3.schemeSet3).slice(0, Math.max(8, violationsAll.length));

  if (state.colorBy === "Violation") {
    // For commonViolation we compute based on the full violation distribution for each street.
    const violToColor = new Map();
    violationsAll.forEach((v, i) => violToColor.set(v, violPalette[i % violPalette.length]));
    fillScale = (viol) => violToColor.get(viol) ?? "#6ea8fe";
  } else {
    // Avg fine is continuous.
    let maxAvg = 0;
    for (const street of dataset.topStreets) {
      const m = mapMetricsByStreet.get(street);
      maxAvg = Math.max(maxAvg, m.avgFine);
    }
    fineScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, Math.max(1, maxAvg)]);
  }

  mapCircles
    .transition()
    .duration(420)
    .attr("r", (d) => {
      const m = mapMetricsByStreet.get(d.street);
      return countScale(m?.totalCount ?? 0);
    })
    .attr("fill", (d) => {
      const m = mapMetricsByStreet.get(d.street);
      if (!m) return "#6ea8fe";
      if (state.colorBy === "Violation") return fillScale(m.commonViolation || "Other");
      return fineScale(m.avgFine);
    })
    .attr("stroke-width", (d) => (state.streetSelected === d.street ? 3 : 1.2))
    .attr("stroke", (d) => (state.streetSelected === d.street ? "#ffffff" : "rgba(255,255,255,0.35)"))
    .attr("opacity", (d) => {
      // Dim when the selection yields 0 tickets (e.g., due to violation/time filters).
      const m = mapMetricsByStreet.get(d.street);
      return m?.totalCount > 0 ? 1 : 0.18;
    });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function formatInt(n) {
  return d3.format(",")(Math.round(n));
}

function updatePointerHints() {
  const mapHint = document.getElementById("mapHint");
  const timeHint = document.getElementById("timeHint");
  const violHint = document.getElementById("violHint");
  if (state.streetSelected) {
    mapHint.textContent = "Click the selected bubble again or the background to clear";
    timeHint.textContent = "Time pattern for selected street";
    violHint.textContent = "Violations within your selected hour range";
  } else {
    mapHint.textContent = "Hover for details • Click a bubble to link all views";
    timeHint.textContent = "Brush to select hours";
    violHint.textContent = "Updates with filters + linked selection";
  }
}

// ---------- Time chart ----------
const timeLayout = { width: 420, height: 190, margin: { top: 18, right: 10, bottom: 28, left: 44 } };
let timeSvg, timeG, timeBars, timeBrushG, timeBrush;
let suppressBrushEnd = false;

function updateTimeChart() {
  const { counts, hourSetSelected } = computeTimeSeriesCounts();

  const width = timeLayout.width;
  const height = timeLayout.height;
  const innerW = width - timeLayout.margin.left - timeLayout.margin.right;
  const innerH = height - timeLayout.margin.top - timeLayout.margin.bottom;

  const x = d3.scaleLinear().domain([0, 23]).range([timeLayout.margin.left, timeLayout.margin.left + innerW]);
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(counts) || 1])
    .nice()
    .range([timeLayout.margin.top + innerH, timeLayout.margin.top]);

  // Axes
  timeG.selectAll(".x-axis").data([0]).join("g").attr("class", "x-axis").attr("transform", `translate(0,${timeLayout.margin.top + innerH})`)
    .call(d3.axisBottom(x).tickValues(d3.range(0, 24, 4)).tickFormat((d) => `${d}:00`));
  timeG.selectAll(".y-axis").data([0]).join("g").attr("class", "y-axis").attr("transform", `translate(${timeLayout.margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat((d) => d3.format(",")(d)));

  timeBars = timeG
    .selectAll("rect.bar")
    .data(hourDomain, (d) => d)
    .join("rect")
    .attr("class", "bar")
    .attr("x", (d) => x(d) - innerW / 48)
    .attr("width", innerW / 24)
    .attr("y", y(0))
    .attr("height", 0)
    .attr("fill", "#6ea8fe")
    .attr("opacity", (d) => (hourSetSelected.has(d) ? 1 : 0.28));

  timeBars
    .transition()
    .duration(420)
    .attr("y", (d) => y(counts[d]))
    .attr("height", (d) => innerH - (y(counts[d]) - timeLayout.margin.top))
    .attr("fill", (d) => (hourSetSelected.has(d) ? "#7ee0c3" : "#6ea8fe"))
    .attr("opacity", (d) => (hourSetSelected.has(d) ? 1 : 0.28));

  // Update brush selection position for the current manual range.
  const h0 = clamp(state.brushMinHour, 0, 23);
  const h1 = clamp(state.brushMaxHour, 0, 23);
  const minH = Math.min(h0, h1);
  const maxH = Math.max(h0, h1);
  suppressBrushEnd = true;
  timeBrushG.call(timeBrush.move, [x(minH) - 2, x(maxH) + 2]);
  suppressBrushEnd = false;
}

function setupTimeChart() {
  timeSvg = d3.select("#timeSvg");
  resizeSVG(timeSvg, timeLayout.width, timeLayout.height);

  timeG = timeSvg.append("g");

  timeG.append("g").attr("class", "x-axis");
  timeG.append("g").attr("class", "y-axis");

  // Brush
  timeBrush = d3
    .brushX()
    .extent([
      [timeLayout.margin.left, timeLayout.margin.top],
      [timeLayout.width - timeLayout.margin.right, timeLayout.height - timeLayout.margin.bottom],
    ])
    .on("end", (event) => {
      if (suppressBrushEnd) return;
      if (!event.selection) return;

      const [x0, x1] = event.selection;
      const innerW = timeLayout.width - timeLayout.margin.left - timeLayout.margin.right;
      const xLinear = d3
        .scaleLinear()
        .domain([0, 23])
        .range([timeLayout.margin.left, timeLayout.margin.left + innerW]);

      const hMin = clamp(Math.round(xLinear.invert(x0)), 0, 23);
      const hMax = clamp(Math.round(xLinear.invert(x1)), 0, 23);
      state.brushMinHour = Math.min(hMin, hMax);
      state.brushMaxHour = Math.max(hMin, hMax);
      render();
    });

  timeBrushG = timeSvg.append("g").attr("class", "brush");
  timeBrushG.call(timeBrush);
}

// ---------- Violation chart ----------
const violLayout = { width: 740, height: 180, margin: { top: 16, right: 16, bottom: 30, left: 250 } };
let violSvg, violG;

function setupViolationChart() {
  violSvg = d3.select("#violSvg");
  resizeSVG(violSvg, violLayout.width, violLayout.height);
  violG = violSvg.append("g");

  violG.append("g").attr("class", "viol-x");
  violG.append("g").attr("class", "viol-y");
}

function updateViolationChart() {
  const bars = computeViolationBars();
  const width = violLayout.width;
  const height = violLayout.height;
  const innerW = width - violLayout.margin.left - violLayout.margin.right;
  const innerH = height - violLayout.margin.top - violLayout.margin.bottom;

  const y = d3.scaleBand().domain(bars.map((d) => d.violation)).range([violLayout.margin.top, violLayout.margin.top + innerH]).padding(0.12);
  const x = d3.scaleLinear().domain([0, d3.max(bars, (d) => d.count) || 1]).nice().range([violLayout.margin.left, violLayout.margin.left + innerW]);

  violG
    .selectAll(".viol-x")
    .data([0])
    .join("g")
    .attr("class", "viol-x")
    .attr("transform", `translate(0,${violLayout.margin.top + innerH})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat((d) => d3.format(",")(d)));

  violG
    .selectAll(".viol-y")
    .data([0])
    .join("g")
    .attr("class", "viol-y")
    .attr("transform", `translate(${violLayout.margin.left},0)`)
    .call(d3.axisLeft(y).tickFormat((d) => abbreviateViolation(d)))
    .call((g) => g.selectAll("text").style("font-size", "13px").style("font-weight", "600"));

  const hourLabel = () => {
    const a = Math.min(state.brushMinHour, state.brushMaxHour);
    const b = Math.max(state.brushMinHour, state.brushMaxHour);
    return a === b ? `${pad2(a)}:00` : `${pad2(a)}:00–${pad2(b)}:00`;
  };

  const rectsMerged = violG
    .selectAll("rect.viol-bar")
    .data(bars, (d) => d.violation)
    .join(
      (enter) =>
        enter
          .append("rect")
          .attr("class", "viol-bar")
          .attr("x", x(0))
          .attr("y", (d) => y(d.violation))
          .attr("height", y.bandwidth())
          .attr("width", 0)
          .attr("fill", "#6ea8fe"),
      (update) => update,
      (exit) => exit.remove()
    );

  rectsMerged
    .style("cursor", "pointer")
    .on("mouseenter", (event, d) => {
      const avgFine = d.count ? `$${d.avgFine.toFixed(2)}` : "—";
      const html = `
        <div style="font-weight:800;margin-bottom:6px">${escapeHtml(d.violation)}</div>
        <div style="color:#a9b6e8">Tickets: <strong style="color:#e8eefc">${formatInt(d.count)}</strong></div>
        <div style="color:#a9b6e8">Avg Fine: <strong style="color:#e8eefc">${avgFine}</strong></div>
        <div style="color:#a9b6e8">Hour Selection: <strong style="color:#e8eefc">${escapeHtml(hourLabel())}</strong></div>
      `;
      tooltipShow(html, event.clientX, event.clientY);
    })
    .on("mousemove", (event) => tooltipMove(event.clientX, event.clientY))
    .on("mouseleave", () => tooltipHide())
    .on("click", (event, d) => {
      event.stopPropagation();
      state.violation = state.violation === d.violation ? "All" : d.violation;
      els.violationSelect.value = state.violation;
      render();
    });

  rectsMerged
    .transition()
    .duration(420)
    .attr("y", (d) => y(d.violation))
    .attr("height", y.bandwidth())
    .attr("x", x(0))
    .attr("width", (d) => x(d.count) - x(0))
    .attr("fill", "#7ee0c3");
}

// ---------- Map setup ----------
function setupMap() {
  mapSvg = d3.select("#mapSvg");
  resizeSVG(mapSvg, mapLayout.width, mapLayout.height);

  mapGZoom = mapSvg.append("g");
  mapG = mapGZoom.append("g").attr("class", "map-layer");

  // Force layout uses node radii based on overall totals (pre-selection).
  const topStreets = dataset.topStreets;
  const nodes = topStreets.map((street) => ({ street }));

  // Base size for simulation stability: use provinceGroup "ON" totals by default.
  // (If the user changes province, circles can grow/shrink but positions remain stable.)
  const baseProvince = state.provinceGroup === "All" ? "ON" : state.provinceGroup;

  const baseCounts = topStreets.map((street) => {
    const rec = streetTotalsIndex.get(idxStreetTotal(baseProvince, street));
    return rec ? rec.count : 0;
  });

  const maxBase = d3.max(baseCounts) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxBase]).range([6, 34]);

  nodes.forEach((n, i) => (n.r = rScale(baseCounts[i])));
  nodes.forEach((n) => {
    n.x = mapLayout.width / 2 + (Math.random() - 0.5) * 80;
    n.y = mapLayout.height / 2 + (Math.random() - 0.5) * 80;
  });

  const mapSimulation = d3
    .forceSimulation(nodes)
    .force("charge", d3.forceManyBody().strength(-10))
    .force("center", d3.forceCenter(mapLayout.width / 2, mapLayout.height / 2))
    .force(
      "collision",
      d3.forceCollide().radius((d) => d.r + 1.5).strength(1)
    )
    .stop();

  for (let i = 0; i < 120; i++) mapSimulation.tick();

  mapCircles = mapG
    .selectAll("circle.streetBubble")
    .data(nodes)
    .join("circle")
    .attr("class", "streetBubble")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", (d) => d.r)
    .attr("fill", "#6ea8fe")
    .attr("stroke", "rgba(255,255,255,0.35)")
    .attr("stroke-width", 1.2)
    .attr("opacity", 1);

  // Zoom/pan
  const zoom = d3
    .zoom()
    .scaleExtent([0.75, 4])
    .on("zoom", (event) => {
      mapGZoom.attr("transform", event.transform);
    });
  mapSvg.call(zoom);

  // Improve cursor affordance.
  mapCircles.style("cursor", "pointer");

  // Clicking empty space clears selection.
  mapSvg.on("click", () => {
    if (state.streetSelected) {
      state.streetSelected = null;
      updatePointerHints();
      render();
    }
  });

  // Map tooltip interactions (use the latest computed metrics from `mapMetricsByStreet`).
  mapCircles
    .on("mouseenter", (event, d) => {
      const m = mapMetricsByStreet.get(d.street);
      if (!m) return;
      const common = m.commonViolation ?? "—";
      const avgFine = m.avgFine ? `$${m.avgFine.toFixed(2)}` : "—";
      const html = `
        <div style="font-weight:800;margin-bottom:6px">${escapeHtml(d.street)}</div>
        <div style="color:#a9b6e8">Tickets: <strong style="color:#e8eefc">${formatInt(m.totalCount)}</strong></div>
        <div style="color:#a9b6e8">Most Common: <strong style="color:#e8eefc">${escapeHtml(common)}</strong></div>
        <div style="color:#a9b6e8">Avg Fine: <strong style="color:#e8eefc">${avgFine}</strong></div>
      `;
      tooltipShow(html, event.clientX, event.clientY);
    })
    .on("mousemove", (event) => tooltipMove(event.clientX, event.clientY))
    .on("mouseleave", () => tooltipHide())
    .on("click", (event, d) => {
      event.stopPropagation();
      state.streetSelected = state.streetSelected === d.street ? null : d.street;
      updatePointerHints();
      render();
    });
}

// ---------- Details panel ----------
function updateDetails() {
  if (!state.streetSelected) {
    els.streetName.textContent = "None selected";
    els.streetTickets.textContent = "—";
    els.streetTopViolation.textContent = "Click a street bubble";
    els.streetAvgFine.textContent = "Click a street bubble";
    return;
  }

  const hourSet = getHourSet();
  const provinceGroupsToUse = getProvinceGroupsSelected();
  const metrics = computeStreetMetrics(state.streetSelected, hourSet, provinceGroupsToUse);

  els.streetName.textContent = state.streetSelected;
  els.streetTickets.textContent = metrics.totalCount ? formatInt(metrics.totalCount) : "0";
  els.streetTopViolation.textContent = metrics.commonViolation ?? "—";
  els.streetAvgFine.textContent = metrics.totalCount ? `$${metrics.avgFine.toFixed(2)}` : "—";
}

function resetState() {
  state.provinceGroup = "ON";
  state.violation = "All";
  state.colorBy = "Violation";
  state.streetSelected = null;
  state.brushMinHour = 0;
  state.brushMaxHour = 23;

  els.provinceSelect.value = state.provinceGroup;
  els.violationSelect.value = state.violation;
  els.colorBySelect.value = state.colorBy;
}

function setupListeners() {
  els.provinceSelect.addEventListener("change", () => {
    state.provinceGroup = els.provinceSelect.value;
    updatePointerHints();
    render();
  });
  els.violationSelect.addEventListener("change", () => {
    state.violation = els.violationSelect.value;
    updatePointerHints();
    render();
  });
  els.colorBySelect.addEventListener("change", () => {
    state.colorBy = els.colorBySelect.value;
    render();
  });

  els.resetBtn.addEventListener("click", () => {
    resetState();
    updatePointerHints();
    render();
  });
}

async function init() {
  try {
    const response = await fetch(dataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${dataUrl}: ${response.status}`);
    dataset = await response.json();
  } catch (err) {
    console.error("Failed to initialize visualization:", err);
    return;
  }

  violationsAll = [...dataset.topViolations, "Other"];

  els.dataSourceLabel.textContent = dataset?.meta?.inputDir
    ? `${dataset.meta.inputDir} (aggregated locally)`
    : "parking-tickets-2024 (aggregated locally)";

  // Build indices
  streetIndex = new Map();
  globalIndex = new Map();
  streetTotalsIndex = new Map();

  for (const rec of dataset.aggStreetHourViolation) {
    const key = idxStreet(rec.provinceGroup, rec.street, rec.hour, rec.violation);
    streetIndex.set(key, { count: rec.count, fineSum: rec.fineSum });
  }
  for (const rec of dataset.aggGlobalHourViolation) {
    const key = idxGlobal(rec.provinceGroup, rec.hour, rec.violation);
    globalIndex.set(key, { count: rec.count, fineSum: rec.fineSum });
  }
  for (const rec of dataset.streetTotals) {
    streetTotalsIndex.set(idxStreetTotal(rec.provinceGroup, rec.street), { count: rec.count, fineSum: rec.fineSum });
  }

  setupControls();
  setupMap();
  setupTimeChart();
  setupViolationChart();
  setupListeners();

  updatePointerHints();
  render();
}

init();

