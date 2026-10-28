import { afterEach } from "vitest";
const restorations: Array<() => void> = [];
export const stubBun = (values: Record<string, unknown>) => {
  const changed = Object.entries(values).filter(([key, value]) => Reflect.get(Bun, key) !== value);
  const previous = Object.fromEntries(changed.map(([key]) => [key, Reflect.get(Bun, key)]));
  for (const [key, value] of changed) {
    if (!Reflect.set(Bun, key, value)) throw new Error(`Cannot replace Bun.${key}`);
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of Object.entries(previous)) Reflect.set(Bun, key, value);
  };
  restorations.push(restore);
  return restore;
};
afterEach(() => {
  for (const restore of restorations.splice(0).toReversed()) restore();
});
