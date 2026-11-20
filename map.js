import { geoNaturalEarth1, geoPath } from 'https://esm.sh/d3-geo@3.1.0';
import * as topojson from 'https://esm.sh/topojson-client@3.1.0';

const WORLD_ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json';

export function initMap(canvas) {
    const ctx = canvas.getContext('2d');
    let landFeatures = null;
    let projection = geoNaturalEarth1();
    const stations = [];

    function draw() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        const dpr = window.devicePixelRatio || 1;

        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Water background
        ctx.fillStyle = '#F2EEE4';
        ctx.fillRect(0, 0, w, h);

        if (landFeatures) {
            projection = geoNaturalEarth1().fitExtent([[24, 24], [w - 24, h - 60]], landFeatures);
            const path = geoPath(projection, ctx);
            ctx.fillStyle = '#E4DFD1';
            ctx.beginPath();
            path(landFeatures);
            ctx.fill();
        }

        // Draw basic dots for active stations
        for (const st of stations) {
            const pt = projection([st.lon, st.lat]);
            if (!pt) continue;
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 5, 0, Math.PI * 2);
            ctx.fillStyle = '#FBF9F2';
            ctx.strokeStyle = '#343632';
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
        }
    }

    window.addEventListener('resize', draw);
    draw();

    // Fetch world landmass geometry and strip Antarctica
    fetch(WORLD_ATLAS_URL)
        .then((res) => res.json())
        .then((topology) => {
            const land = topojson.feature(topology, topology.objects.land);
            // Filter out polygons whose max latitude is below -60 (Antarctica)
            for (const feature of land.features) {
                if (feature.geometry?.type === 'MultiPolygon') {
                    feature.geometry.coordinates = feature.geometry.coordinates.filter((poly) => {
                        const outer = poly[0] || [];
                        return outer.some((pt) => pt[1] >= -60);
                    });
                }
            }
            landFeatures = land;
            draw();
        });

    function addStation(lon, lat) {
        stations.push({ lon, lat });
        if (stations.length > 100) stations.shift();
        draw();
    }

    return { addStation };
}