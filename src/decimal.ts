export function parseDecimal(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Invalid scale ${scale}`);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal ${value}`);

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > scale) throw new Error(`Too many decimal places for scale ${scale}: ${value}`);

  const atomic = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
  return sign * atomic;
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
