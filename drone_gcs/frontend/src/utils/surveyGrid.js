/**
 * Build a lawnmower / grid survey as NAV_WAYPOINT (16) items in MAV_FRAME_GLOBAL_RELATIVE_ALT (3).
 * Heading is degrees from north, clockwise (aviation-style).
 */

const D2R = Math.PI / 180;
const R_EARTH = 6371000;

function mPerDegLat() {
  return (Math.PI * R_EARTH) / 180;
}

function mPerDegLng(latDeg) {
  return mPerDegLat() * Math.cos(latDeg * D2R);
}

/**
 * @param {object} opts
 * @param {number} opts.centerLat
 * @param {number} opts.centerLng
 * @param {number} opts.widthM  swath width perpendicular to flight lines
 * @param {number} opts.lengthM  extent along each pass
 * @param {number} opts.headingDeg  direction of flight lines (0=north, 90=east)
 * @param {number} opts.lineSpacingM  distance between parallel passes
 * @param {number} opts.alongSpacingM  spacing between waypoints along a pass
 * @param {number} opts.altitudeM
 * @param {number} [opts.command=16]
 */
export function buildSurveyWaypoints(opts) {
  const {
    centerLat,
    centerLng,
    widthM,
    lengthM,
    headingDeg,
    lineSpacingM,
    alongSpacingM,
    altitudeM,
    command = 16,
  } = opts;

  const latIn = Number(centerLat);
  const lngIn = Number(centerLng);
  if (!Number.isFinite(latIn) || !Number.isFinite(lngIn)) {
    throw new Error('Survey center latitude/longitude must be valid numbers.');
  }
  const lat0 = Math.max(-89.9, Math.min(89.9, latIn));
  const lng0 = ((lngIn + 540) % 360) - 180;
  const w = Math.max(10, Number(widthM) || 50);
  const L = Math.max(10, Number(lengthM) || 50);
  const h = Number(headingDeg) || 0;
  const lineStep = Math.max(5, Number(lineSpacingM) || 15);
  const alongStep = Math.max(5, Number(alongSpacingM) || 15);
  const alt = Number(altitudeM) || 50;

  const halfW = w / 2;
  const halfL = L / 2;
  const hr = h * D2R;
  // Unit along-track (east, north) meters
  const ae = Math.sin(hr);
  const an = Math.cos(hr);
  // Unit cross-track (to the right of along), meters
  const ce = Math.cos(hr);
  const cn = -Math.sin(hr);

  const numStripes = Math.max(1, Math.ceil(w / lineStep));
  const crossPositions = [];
  for (let i = 0; i < numStripes; i++) {
    const u = numStripes === 1 ? 0 : -halfW + (i * w) / (numStripes - 1);
    crossPositions.push(u);
  }

  const mLat = mPerDegLat();
  const mLng = mPerDegLng(lat0);
  if (!Number.isFinite(mLng) || Math.abs(mLng) < 1e-6) {
    throw new Error('Survey center latitude is too close to pole; choose a different center.');
  }

  const toLatLng = (eastM, northM) => ({
    lat: Math.max(-89.9, Math.min(89.9, lat0 + northM / mLat)),
    lng: ((lng0 + eastM / mLng + 540) % 360) - 180,
  });

  const points = [];
  const alongSamples = Math.max(2, Math.ceil((2 * halfL) / alongStep) + 1);
  const ts = [];
  for (let i = 0; i < alongSamples; i++) {
    const t = -halfL + (i * (2 * halfL)) / (alongSamples - 1);
    ts.push(t);
  }

  crossPositions.forEach((crossOff, stripeIdx) => {
    const forward = stripeIdx % 2 === 0;
    const order = forward ? ts : [...ts].reverse();
    order.forEach((alongOff) => {
      const eastM = crossOff * ce + alongOff * ae;
      const northM = crossOff * cn + alongOff * an;
      const { lat, lng } = toLatLng(eastM, northM);
      points.push({
        frame: 3,
        command,
        current: 0,
        autocontinue: 1,
        param1: 0,
        param2: 0,
        param3: 0,
        param4: 0,
        lat,
        lng,
        alt,
      });
    });
  });

  const MAX_WAYPOINTS = 450;
  let out = points;
  if (out.length > MAX_WAYPOINTS) {
    const stride = Math.ceil(out.length / MAX_WAYPOINTS);
    out = out.filter((_, i) => i % stride === 0);
  }

  return out.map((wp, seq) => ({
    ...wp,
    seq,
    current: seq === 0 ? 1 : 0,
  }));
}
