// =====================================================================
//  dtcDict.ts — offline OBD-II trouble-code reference (no backend, no key).
//
//  Two layers:
//   1) a curated dictionary of the most common GENERIC (SAE) codes with a
//      short plain-language title + a one-line "what it means" detail;
//   2) a STRUCTURAL fallback that decodes ANY well-formed code from its
//      letter + digits (system + subsystem) so an unlisted or manufacturer
//      code still gets a useful category instead of "unknown".
//
//  Generic only — manufacturer-specific meanings (P1xxx / P30xx+ etc.) vary by
//  make, so we say so rather than guess. Not medical/legal advice for your car;
//  a stored code is a starting point, not a diagnosis.
// =====================================================================

export interface DtcInfo {
  code: string;      // normalised, e.g. "P0301"
  title: string;     // short human title
  detail: string;    // one-line explanation
  system: string;    // Powertrain / Chassis / Body / Network (+ subsystem)
  generic: boolean;  // true = SAE-generic meaning; false = manufacturer-specific
  known: boolean;    // true = found in the curated dictionary
}

// Curated common generic codes. Kept compact: [title, detail].
const DICT: Record<string, [string, string]> = {
  // Fuel & air metering / mixture
  P0100: ['MAF circuit', 'Mass-airflow sensor signal fault — can cause rough running or stalling.'],
  P0101: ['MAF range/performance', 'Airflow reading is out of the expected range — often a dirty MAF or intake leak.'],
  P0102: ['MAF low input', 'Airflow sensor reading too low — wiring, connector, or a failing sensor.'],
  P0113: ['Intake air temp high', 'IAT sensor reads too high (open circuit) — sensor or wiring.'],
  P0120: ['Throttle position sensor', 'Throttle/pedal position sensor circuit fault.'],
  P0128: ['Coolant thermostat', 'Engine not reaching normal temperature — usually a stuck-open thermostat.'],
  P0130: ['O2 sensor (B1S1)', 'Front oxygen sensor circuit fault, bank 1.'],
  P0131: ['O2 sensor low (B1S1)', 'Front O2 sensor stuck lean/low — sensor, wiring, or an exhaust leak.'],
  P0133: ['O2 sensor slow (B1S1)', 'Front O2 sensor responding slowly — often an ageing sensor.'],
  P0135: ['O2 heater (B1S1)', 'Front O2 sensor heater circuit fault, bank 1.'],
  P0136: ['O2 sensor (B1S2)', 'Rear (post-cat) oxygen sensor circuit fault, bank 1.'],
  P0171: ['System too lean (B1)', 'Too much air / too little fuel, bank 1 — vacuum leak, weak fuel pump, dirty MAF.'],
  P0172: ['System too rich (B1)', 'Too much fuel, bank 1 — leaking injector, high fuel pressure, or a MAF fault.'],
  P0174: ['System too lean (B2)', 'Lean mixture on bank 2 — vacuum leak or fuel-delivery issue.'],
  P0175: ['System too rich (B2)', 'Rich mixture on bank 2 — injector or fuel-pressure issue.'],
  P0087: ['Fuel rail pressure low', 'Fuel pressure below target — pump, filter, or regulator.'],
  P0089: ['Fuel pressure regulator', 'Fuel pressure regulator performance fault.'],
  // Ignition / misfire
  P0300: ['Random misfire', 'Multiple cylinders misfiring — plugs, coils, fuel, or a vacuum leak.'],
  P0301: ['Cylinder 1 misfire', 'Cylinder 1 is misfiring — coil, plug, injector, or compression.'],
  P0302: ['Cylinder 2 misfire', 'Cylinder 2 is misfiring — coil, plug, injector, or compression.'],
  P0303: ['Cylinder 3 misfire', 'Cylinder 3 is misfiring — coil, plug, injector, or compression.'],
  P0304: ['Cylinder 4 misfire', 'Cylinder 4 is misfiring — coil, plug, injector, or compression.'],
  P0305: ['Cylinder 5 misfire', 'Cylinder 5 is misfiring — coil, plug, injector, or compression.'],
  P0306: ['Cylinder 6 misfire', 'Cylinder 6 is misfiring — coil, plug, injector, or compression.'],
  P0325: ['Knock sensor', 'Knock-sensor circuit fault — may reduce timing/power.'],
  P0335: ['Crankshaft position sensor', 'Crank position sensor fault — can cause no-start or stalling.'],
  P0340: ['Camshaft position sensor', 'Cam position sensor fault — timing/sync issue.'],
  // Emissions / EGR / EVAP / catalyst
  P0401: ['EGR flow insufficient', 'Exhaust-gas recirculation flow too low — clogged EGR or passages.'],
  P0402: ['EGR flow excessive', 'EGR flow too high — stuck EGR valve.'],
  P0411: ['Secondary air', 'Secondary air-injection system fault.'],
  P0420: ['Catalyst efficiency (B1)', 'Catalytic converter below threshold, bank 1 — often the cat, sometimes an O2 sensor.'],
  P0430: ['Catalyst efficiency (B2)', 'Catalytic converter below threshold, bank 2.'],
  P0440: ['EVAP system', 'Evaporative emissions (fuel-vapour) system fault.'],
  P0442: ['EVAP small leak', 'Small fuel-vapour leak — very often a loose or bad fuel cap.'],
  P0446: ['EVAP vent control', 'EVAP vent valve/circuit fault.'],
  P0455: ['EVAP large leak', 'Large fuel-vapour leak — missing/loose fuel cap or a cracked hose.'],
  P0456: ['EVAP very small leak', 'Very small vapour leak — fuel cap seal or a tiny hose crack.'],
  // Speed / idle / aux inputs
  P0500: ['Vehicle speed sensor', 'Speed-sensor signal fault.'],
  P0505: ['Idle control', 'Idle air control system fault — rough or hunting idle.'],
  P0506: ['Idle RPM low', 'Idle speed lower than expected.'],
  P0507: ['Idle RPM high', 'Idle speed higher than expected — often a vacuum leak.'],
  // Computer / charging / body
  P0562: ['System voltage low', 'Battery/charging voltage low — battery, alternator, or wiring.'],
  P0563: ['System voltage high', 'Charging voltage too high — voltage regulator.'],
  P0600: ['Serial comms link', 'Internal module communication fault.'],
  P0606: ['ECM/PCM processor', 'Engine control module internal fault.'],
  // Transmission
  P0700: ['Transmission control', 'Transmission control system flagged a fault — read the TCM for a sub-code.'],
  P0715: ['Input speed sensor', 'Transmission input/turbine speed sensor fault.'],
  P0730: ['Incorrect gear ratio', 'Gear ratio not as expected — slipping or a sensor/solenoid fault.'],
  P0740: ['Torque converter clutch', 'TCC circuit fault — can cause shudder or poor economy.'],
  P0741: ['TCC stuck off', 'Torque-converter clutch not engaging (stuck off).'],
  // Network (U-codes)
  U0100: ['Lost comms with ECM', 'No communication with the engine controller on the bus.'],
  U0101: ['Lost comms with TCM', 'No communication with the transmission controller.'],
  U0121: ['Lost comms with ABS', 'No communication with the ABS controller.'],
  U0140: ['Lost comms with body module', 'No communication with the body control module.'],
};

// Subsystem name from a Powertrain code's 3rd digit (P _ x __).
const P_SUB: Record<string, string> = {
  '0': 'fuel & air metering / emissions',
  '1': 'fuel & air metering',
  '2': 'fuel & air metering (injector)',
  '3': 'ignition / misfire',
  '4': 'auxiliary emissions',
  '5': 'speed / idle / aux inputs',
  '6': 'computer & output circuits',
  '7': 'transmission',
  '8': 'transmission',
  '9': 'transmission (control)',
  A: 'hybrid propulsion',
  B: 'hybrid propulsion',
  C: 'hybrid propulsion',
};

const LETTER_SYS: Record<string, string> = {
  P: 'Powertrain',
  C: 'Chassis',
  B: 'Body',
  U: 'Network',
};

/** Normalise raw user/wire input to a canonical code, or '' if not a plausible code. */
export function normalizeDtc(raw: string): string {
  const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Letter + 4 hex-ish chars (2nd char 0..3 for standard OBD-II).
  return /^[PCBU][0-3][0-9A-F]{3}$/.test(s) ? s : '';
}

/** Explain a single trouble code (curated dictionary → structural fallback). */
export function explainDtc(raw: string): DtcInfo | null {
  const code = normalizeDtc(raw);
  if (!code) return null;

  const letter = code[0];
  const generic = code[1] === '0' || code[1] === '2'; // SAE-generic banks
  const sys = LETTER_SYS[letter] ?? 'Unknown';

  const hit = DICT[code];
  if (hit) {
    return { code, title: hit[0], detail: hit[1], system: sys, generic: true, known: true };
  }

  // Structural fallback — category from the digits.
  let system = sys;
  let detail: string;
  if (letter === 'P') {
    const sub = P_SUB[code[2]] ?? 'engine/drivetrain';
    system = `Powertrain — ${sub}`;
    detail = generic
      ? `Generic powertrain code in the ${sub} group. Not in the built-in list — look it up for the exact meaning.`
      : `Manufacturer-specific powertrain code (${sub}) — its meaning depends on the make. Check the maker's list.`;
  } else if (!generic) {
    detail = `Manufacturer-specific ${sys.toLowerCase()} code — its meaning depends on the make.`;
  } else {
    detail = `Generic ${sys.toLowerCase()} code. Not in the built-in list — look it up for the exact meaning.`;
  }
  return { code, title: `${system} code`, detail, system, generic, known: false };
}

/** Explain a list of codes (skips anything that isn't a plausible code). */
export function explainDtcList(codes: string[]): DtcInfo[] {
  const out: DtcInfo[] = [];
  const seen = new Set<string>();
  for (const c of codes) {
    const info = explainDtc(c);
    if (info && !seen.has(info.code)) { seen.add(info.code); out.push(info); }
  }
  return out;
}
