import { geoNaturalEarth1, geoPath } from 'https://esm.sh/d3-geo@3.1.0';
import * as topojson from 'https://esm.sh/topojson-client@3.1.0';

const WORLD_ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json';

const REF_WIDTH = 1600;
const REF_HEIGHT = 800;
const REF_PADDING = 24;

const MIN_RING_AREA = 8.0;
const SIMPLIFY_TOLERANCE = 2.0;
const MAX_SEGMENT_LEN = 18.0;
const STATION_RADIUS = 5.4;
const STATION_STROKE_WIDTH = 2.1;
const POP_IN_MS = 400;
const PULSE_DELAY_MS = 100;
const PULSE_DURATION_MS = 1150;
const PULSE_MAX_MULTIPLIER = 6.3;
const PULSE_STROKE_WIDTH = 1.5;
const HOLD_MS = 8000;
const SHRINK_MS = 500;
const MAX_ACTIVE_STATIONS = 150;
const HARD_STATION_LIMIT = 180;

const WATER_COLOR = '#F2EEE4';
const LAND_COLOR = '#E4DFD1';
const STATION_FILL = '#FBF9F2';
const STATION_STROKE = '#343632';

function getRingArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % ring.length];
        sum += p1[0] * p2[1] - p2[0] * p1[1];
    }
    return sum * 0.5;
}

// Perpendicular squared distance from point p to segment a-b
function pointToSegmentSqDist(p, a, b) {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;

    if (dx !== 0 || dy !== 0) {
        const t = Math.max(0, Math.min(1, ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)));
        x += dx * t;
        y += dy * t;
    }

    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
}

// Classic recursive Douglas-Peucker line simplification
function douglasPeucker(points, tolerance) {
    if (points.length <= 2) return points;

    let maxDist = 0;
    let splitIdx = -1;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const d = pointToSegmentSqDist(points[i], first, last);
        if (d > maxDist) {
            maxDist = d;
            splitIdx = i;
        }
    }

    if (maxDist > tolerance * tolerance && splitIdx !== -1) {
        const left = douglasPeucker(points.slice(0, splitIdx + 1), tolerance);
        const right = douglasPeucker(points.slice(splitIdx), tolerance);
        return left.slice(0, -1).concat(right);
    }
    return [first, last];
}

// Split a closed ring at two opposite points before simplifying so the start/end vertex doesn't pinch
function simplifyClosedRing(ring, tolerance) {
    if (ring.length < 4) return ring;
    const mid = Math.floor(ring.length / 2);
    const arc1 = douglasPeucker(ring.slice(0, mid + 1), tolerance);
    const arc2 = douglasPeucker(ring.slice(mid).concat([ring[0]]), tolerance);
    return arc1.slice(0, -1).concat(arc2.slice(0, -1));
}

// Break up long straight edges so quadratic curve smoothing doesn't over-round straight borders
function subdivideLongEdges(ring, maxLen) {
    if (ring.length < 3) return ring;
    const out = [];
    for (let i = 0; i < ring.length; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % ring.length];
        out.push(p1);
        const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (len > maxLen) {
            const steps = Math.ceil(len / maxLen);
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                out.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]);
            }
        }
    }
    return out;
}

// Midpoint quadratic B-spline smoothing for the rounded Mini Metro coastline look
function traceSmoothRing(ctx, ring) {
    if (ring.length < 3) return;
    const last = ring[ring.length - 1];
    const first = ring[0];
    ctx.moveTo((last[0] + first[0]) * 0.5, (last[1] + first[1]) * 0.5);
    for (let i = 0; i < ring.length; i++) {
        const curr = ring[i];
        const next = ring[(i + 1) % ring.length];
        ctx.quadraticCurveTo(curr[0], curr[1], (curr[0] + next[0]) * 0.5, (curr[1] + next[1]) * 0.5);
    }
    ctx.closePath();
}

function projectPolygonRings(polyCoords, refProjection) {
    const rings = [];
    let current = null;
    const collector = {
        beginPath() { },
        moveTo(x, y) {
            current = [[x, y]];
            rings.push(current);
        },
        lineTo(x, y) {
            if (current) current.push([x, y]);
        },
        closePath() {
            current = null;
        },
    };
    geoPath(refProjection, collector)({ type: 'Polygon', coordinates: polyCoords });
    return rings;
}

function buildSmoothedPolygons(landFc, refProjection) {
    const polygons = [];
    const rawPolys = [];

    for (const feature of landFc.features || []) {
        if (!feature.geometry) continue;
        if (feature.geometry.type === 'Polygon') rawPolys.push(feature.geometry.coordinates);
        if (feature.geometry.type === 'MultiPolygon') rawPolys.push(...feature.geometry.coordinates);
    }

    for (const polyCoords of rawPolys) {
        // Skip Antarctica (all latitudes below -60)
        const outerLonLat = polyCoords[0] || [];
        if (outerLonLat.length > 0 && outerLonLat.every((pt) => pt[1] < -60)) continue;

        const projectedRings = projectPolygonRings(polyCoords, refProjection);
        const outers = [];
        const holes = [];

        for (const ring of projectedRings) {
            const rawArea = getRingArea(ring);
            if (Math.abs(rawArea) < MIN_RING_AREA) continue;

            const simplified = simplifyClosedRing(ring, SIMPLIFY_TOLERANCE);
            if (simplified.length < 3 || Math.abs(getRingArea(simplified)) < MIN_RING_AREA) continue;

            const smoothRing = subdivideLongEdges(simplified, MAX_SEGMENT_LEN);
            if (rawArea < 0) {
                holes.push(smoothRing);
            } else {
                outers.push({ ring: smoothRing, area: Math.abs(rawArea) });
            }
        }

        if (outers.length === 1) {
            polygons.push({ outer: outers[0].ring, holes });
        } else if (outers.length > 1) {
            outers.sort((a, b) => b.area - a.area);
            polygons.push({ outer: outers[0].ring, holes });
            for (let i = 1; i < outers.length; i++) {
                polygons.push({ outer: outers[i].ring, holes: [] });
            }
        }
    }

    return polygons;
}

function computeBounds(polygons) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const poly of polygons) {
        for (const [x, y] of poly.outer) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (!Number.isFinite(minX)) return { minX: 0, maxX: REF_WIDTH, minY: 0, maxY: REF_HEIGHT };
    return { minX, maxX, minY, maxY };
}

function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = 2.70158;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

export function initMap(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const landCanvas = document.createElement('canvas');
    const landCtx = landCanvas.getContext('2d', { alpha: false });

    let refScale = 250;
    let refTranslate = [REF_WIDTH * 0.5, REF_HEIGHT * 0.5];
    let smoothedPolygons = [];
    let landBounds = { minX: 0, maxX: REF_WIDTH, minY: 0, maxY: REF_HEIGHT };
    let liveProjection = geoNaturalEarth1();

    let cssWidth = 0;
    let cssHeight = 0;
    let currentDpr = 1;
    let dotScaleFactor = 1;
    let needsDraw = true;
    const stations = [];

    function updateLayoutAndLandCache() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        cssWidth = w;
        cssHeight = h;
        currentDpr = dpr;

        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        landCanvas.width = canvas.width;
        landCanvas.height = canvas.height;

        const bottomBarHeight = w <= 860 ? 44 : 48;
        const availH = Math.max(1, h - bottomBarHeight);

        const boundsW = Math.max(1, landBounds.maxX - landBounds.minX);
        const boundsH = Math.max(1, landBounds.maxY - landBounds.minY);
        const boundsCenterX = (landBounds.minX + landBounds.maxX) * 0.5;

        const widthPad = w < availH ? 0.97 : 0.96;
        const scale = Math.min((w * widthPad) / boundsW, (availH * 0.935) / boundsH);
        dotScaleFactor = Math.max(0.68, Math.min(1, scale * 1.15));

        const visualCenterX = boundsCenterX + boundsW * 0.01;
        const offsetX = w * 0.5 - visualCenterX * scale;
        const topSpace = Math.max(availH * 0.052, (availH - boundsH * scale) * 0.5);
        const offsetY = topSpace - landBounds.minY * scale;

        liveProjection = geoNaturalEarth1()
            .scale(refScale * scale)
            .translate([offsetX + refTranslate[0] * scale, offsetY + refTranslate[1] * scale]);

        landCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        landCtx.fillStyle = WATER_COLOR;
        landCtx.fillRect(0, 0, w, h);

        if (smoothedPolygons.length > 0) {
            landCtx.save();
            landCtx.translate(offsetX, offsetY);
            landCtx.scale(scale, scale);
            landCtx.fillStyle = LAND_COLOR;

            for (const poly of smoothedPolygons) {
                landCtx.beginPath();
                traceSmoothRing(landCtx, poly.outer);
                for (const hole of poly.holes) {
                    traceSmoothRing(landCtx, hole);
                }
                landCtx.fill();
            }
            landCtx.restore();
        }

        // Re-project existing stations if the window resized
        for (const st of stations) {
            const pt = liveProjection([st.lon, st.lat]);
            if (pt) {
                st.x = pt[0];
                st.y = pt[1];
            }
        }

        needsDraw = true;
    }

    function checkResize() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        if (w !== cssWidth || h !== cssHeight || dpr !== currentDpr) {
            updateLayoutAndLandCache();
        }
    }

    new ResizeObserver(updateLayoutAndLandCache).observe(canvas.parentElement || canvas);
    window.addEventListener('resize', updateLayoutAndLandCache);
    updateLayoutAndLandCache();

    fetch(WORLD_ATLAS_URL)
        .then((res) => res.json())
        .then((topology) => {
            const landFc = topojson.feature(topology, topology.objects.land);
            const refProjection = geoNaturalEarth1().fitExtent(
                [[REF_PADDING, REF_PADDING], [REF_WIDTH - REF_PADDING, REF_HEIGHT - REF_PADDING]],
                landFc
            );
            refScale = refProjection.scale();
            refTranslate = refProjection.translate();
            smoothedPolygons = buildSmoothedPolygons(landFc, refProjection);
            landBounds = computeBounds(smoothedPolygons);
            updateLayoutAndLandCache();
        })
        .catch(() => { });

    function addStation(lon, lat, color, onExitStart) {
        const pt = liveProjection([lon, lat]);
        if (!pt) return false;

        const now = performance.now();
        stations.push({
            lon,
            lat,
            x: pt[0],
            y: pt[1],
            color,
            createdAt: now,
            exitStartAt: now + POP_IN_MS + HOLD_MS,
            exitingNotified: false,
            onExitStart: typeof onExitStart === 'function' ? onExitStart : null,
            scale: 0,
            pulseRadius: STATION_RADIUS,
            pulseAlpha: 0,
        });

        // Gently expire oldest stations if too many accumulate during spikes
        let activeCount = stations.filter((s) => s.exitStartAt > now).length;
        if (activeCount > MAX_ACTIVE_STATIONS) {
            let toExpire = activeCount - MAX_ACTIVE_STATIONS;
            for (let i = 0; i < stations.length && toExpire > 0; i++) {
                if (stations[i].exitStartAt > now) {
                    stations[i].exitStartAt = now;
                    toExpire--;
                }
            }
        }

        if (stations.length > HARD_STATION_LIMIT) {
            const removed = stations.splice(0, stations.length - HARD_STATION_LIMIT);
            for (const st of removed) {
                if (!st.exitingNotified && st.onExitStart) {
                    st.exitingNotified = true;
                    st.onExitStart();
                }
            }
        }

        needsDraw = true;
        return true;
    }

    function renderFrame(now) {
        checkResize();

        if (stations.length === 0 && !needsDraw) {
            requestAnimationFrame(renderFrame);
            return;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(landCanvas, 0, 0);
        ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);

        // Update station lifecycles and filter out finished ones
        for (let i = stations.length - 1; i >= 0; i--) {
            const st = stations[i];
            const age = now - st.createdAt;
            const baseScale = age < POP_IN_MS ? Math.max(0, easeOutBack(age / POP_IN_MS)) : 1;

            if (now >= st.exitStartAt) {
                if (!st.exitingNotified) {
                    st.exitingNotified = true;
                    if (st.onExitStart) st.onExitStart();
                }
                const shrinkT = (now - st.exitStartAt) / SHRINK_MS;
                if (shrinkT >= 1) {
                    stations.splice(i, 1);
                    continue;
                }
                st.scale = Math.max(0, baseScale * (1 - shrinkT ** 3));
                st.pulseAlpha = 0;
            } else {
                st.scale = baseScale;
                const pulseAge = age - PULSE_DELAY_MS;
                if (pulseAge >= 0 && pulseAge < PULSE_DURATION_MS) {
                    const pt = pulseAge / PULSE_DURATION_MS;
                    const eased = 1 - (1 - pt) ** 3;
                    st.pulseRadius = STATION_RADIUS * dotScaleFactor * (1 + (PULSE_MAX_MULTIPLIER - 1) * eased);
                    st.pulseAlpha = Math.max(0, (1 - pt) ** 1.35 * 0.85);
                } else {
                    st.pulseAlpha = 0;
                }
            }
        }

        // Pass 1: Expanding language-colored pulse rings
        ctx.lineWidth = PULSE_STROKE_WIDTH * dotScaleFactor;
        for (const st of stations) {
            if (st.pulseAlpha > 0.005) {
                ctx.globalAlpha = st.pulseAlpha;
                ctx.strokeStyle = st.color;
                ctx.beginPath();
                ctx.arc(st.x, st.y, st.pulseRadius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // Pass 2: White ink-ringed station circles
        ctx.fillStyle = STATION_FILL;
        ctx.strokeStyle = STATION_STROKE;
        for (const st of stations) {
            if (st.scale > 0.01) {
                const radius = STATION_RADIUS * dotScaleFactor * st.scale;
                ctx.lineWidth = STATION_STROKE_WIDTH * dotScaleFactor * st.scale;
                ctx.beginPath();
                ctx.arc(st.x, st.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        needsDraw = stations.length > 0;
        requestAnimationFrame(renderFrame);
    }

    requestAnimationFrame(renderFrame);
    return { addStation };
}