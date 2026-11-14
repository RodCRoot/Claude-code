/**
 * Pure ordering logic for the drag-and-drop program builder (shared by the client builder for
 * its optimistic preview and by `saveProgramLayout` on the server, which is authoritative).
 *
 * Model: each day is an ordered list of items; consecutive items with the same `group` form one
 * block (superset/circuit). `group` is an opaque client key — the server never trusts labels from
 * the client: it recomputes every label and block type with `normalizeDay`:
 *   - blocks are lettered A, B, C… in order; members are numbered 1..n (a single item is "A1");
 *   - a single-item block is "straight"; a multi-item block stays "circuit" if any member was a
 *     circuit, otherwise it becomes a "superset".
 */
export type BlockType = "straight" | "superset" | "circuit";
export type LayoutItem = { id: string; group: string; blockType: BlockType };
export type DayLayout = { dayId: string; items: LayoutItem[] };
export type NormalizedItem = { id: string; sortOrder: number; blockLabel: string; blockType: BlockType };

export const MAX_BLOCKS_PER_DAY = 26;

/** Initial group keys from stored labels: consecutive items sharing a block letter are one block. */
export function groupsFromLabels(dayId: string, items: { id: string; blockLabel: string; blockType: BlockType }[]): LayoutItem[] {
  let run = -1;
  let prevLetter: string | null = null;
  return items.map((it) => {
    const letter = it.blockLabel.charAt(0);
    if (letter !== prevLetter) run++;
    prevLetter = letter;
    return { id: it.id, group: `${dayId}:${run}`, blockType: it.blockType };
  });
}

/** Contiguous runs of equal `group`, in order. */
export function blocksOf<T extends { group: string }>(items: T[]): T[][] {
  const out: T[][] = [];
  for (const it of items) {
    const last = out.at(-1);
    if (last && last[0].group === it.group) last.push(it);
    else out.push([it]);
  }
  return out;
}

/** Authoritative sort order, block labels and block types for one day. */
export function normalizeDay(items: LayoutItem[]): NormalizedItem[] {
  const blocks = blocksOf(items);
  if (blocks.length > MAX_BLOCKS_PER_DAY) throw new RangeError(`A day can have at most ${MAX_BLOCKS_PER_DAY} blocks (A–Z).`);
  const out: NormalizedItem[] = [];
  blocks.forEach((b, bi) => {
    const letter = String.fromCharCode(65 + bi);
    const type: BlockType = b.length === 1 ? "straight" : b.some((x) => x.blockType === "circuit") ? "circuit" : "superset";
    b.forEach((it, k) => out.push({ id: it.id, sortOrder: out.length, blockLabel: `${letter}${k + 1}`, blockType: type }));
  });
  return out;
}

const fresh = (id: string) => `solo:${id}:${Math.random().toString(36).slice(2, 8)}`;

function locate(days: DayLayout[], itemId: string) {
  for (let d = 0; d < days.length; d++) {
    const i = days[d].items.findIndex((x) => x.id === itemId);
    if (i >= 0) return { d, i, item: days[d].items[i] };
  }
  return null;
}

function cloneDays(days: DayLayout[]): DayLayout[] {
  return days.map((d) => ({ dayId: d.dayId, items: d.items.map((x) => ({ ...x })) }));
}

/** Insert `itemId` into `toDayId` at `index` (index counted after removing the item), with `group`. */
export function placeItem(days: DayLayout[], itemId: string, toDayId: string, index: number, group?: string): DayLayout[] {
  const next = cloneDays(days);
  const at = locate(next, itemId);
  const target = next.find((d) => d.dayId === toDayId);
  if (!at || !target) return days;
  const [item] = next[at.d].items.splice(at.i, 1);
  item.group = group ?? fresh(item.id);
  const i = Math.max(0, Math.min(index, target.items.length));
  target.items.splice(i, 0, item);
  return next;
}

/**
 * Keyboard "move up/down" (one step), block-aware:
 * - inside a multi-item block, swaps with the neighbouring member;
 * - at the edge of a multi-item block, steps out of the block (becomes its own block next to it);
 * - a single-item block jumps over the whole neighbouring block.
 */
export function moveStep(days: DayLayout[], itemId: string, dir: -1 | 1): DayLayout[] {
  const at = locate(days, itemId);
  if (!at) return days;
  const list = days[at.d].items;
  const blocks = blocksOf(list);
  const bi = blocks.findIndex((b) => b.some((x) => x.id === itemId));
  const block = blocks[bi];
  const k = block.findIndex((x) => x.id === itemId);
  const start = list.indexOf(block[0]);
  if (block.length > 1) {
    const nk = k + dir;
    if (nk >= 0 && nk < block.length) {
      // Swap with the neighbouring member (stays in the block).
      return placeItem(days, itemId, days[at.d].dayId, start + nk, block[0].group);
    }
    // Step out of the block on that side.
    const index = dir < 0 ? start : start + block.length - 1;
    return placeItem(days, itemId, days[at.d].dayId, index);
  }
  const neighbour = blocks[bi + dir];
  if (!neighbour) return days;
  // After removing the item, jump to just before/after the neighbouring block.
  const nStart = list.indexOf(neighbour[0]);
  const index = dir < 0 ? nStart : nStart + neighbour.length - 1;
  return placeItem(days, itemId, days[at.d].dayId, index, block[0].group);
}

/** Make the item the last member of the block above it (e.g. build a superset). */
export function joinPrevious(days: DayLayout[], itemId: string): DayLayout[] {
  const at = locate(days, itemId);
  if (!at) return days;
  const list = days[at.d].items;
  const blocks = blocksOf(list);
  const bi = blocks.findIndex((b) => b.some((x) => x.id === itemId));
  const prev = blocks[bi - 1];
  if (!prev) return days;
  // The item sits after `prev`, so removing it doesn't shift prev's indices.
  const prevEnd = list.indexOf(prev.at(-1)!);
  return placeItem(days, itemId, days[at.d].dayId, prevEnd + 1, prev[0].group);
}

/** Take the item out of its multi-item block; it becomes its own block right after it. */
export function separate(days: DayLayout[], itemId: string): DayLayout[] {
  const at = locate(days, itemId);
  if (!at) return days;
  const list = days[at.d].items;
  const block = blocksOf(list).find((b) => b.some((x) => x.id === itemId))!;
  if (block.length < 2) return days;
  const end = list.indexOf(block.at(-1)!);
  return placeItem(days, itemId, days[at.d].dayId, end); // after removal, `end` is just past the block
}

/** Move to the end of another day as its own block (keyboard "Move to day"). */
export function moveToDay(days: DayLayout[], itemId: string, toDayId: string): DayLayout[] {
  const target = days.find((d) => d.dayId === toDayId);
  if (!target) return days;
  return placeItem(days, itemId, toDayId, target.items.length);
}

/**
 * Drag-and-drop onto another item (`before`/`after` = upper/lower half of the target).
 * Dropping on the outer edge of a block (before its first member / after its last) places the
 * item next to the block as its own block; dropping between members joins that block. Reordering
 * inside the dragged item's own block keeps it in the block (use "Separate" to leave it).
 */
export function dropOnItem(days: DayLayout[], itemId: string, targetId: string, position: "before" | "after"): DayLayout[] {
  if (itemId === targetId) return days;
  const t = locate(days, targetId);
  if (!t) return days;
  const list = days[t.d].items;
  const block = blocksOf(list).find((b) => b.some((x) => x.id === targetId))!;
  const k = block.findIndex((x) => x.id === targetId);
  const outerEdge = (position === "before" && k === 0) || (position === "after" && k === block.length - 1);
  const dragged = locate(days, itemId);
  if (!dragged) return days;
  const joins = !outerEdge || dragged.item.group === block[0].group;
  const without = list.filter((x) => x.id !== itemId);
  const ti = without.findIndex((x) => x.id === targetId);
  const index = position === "before" ? ti : ti + 1;
  return placeItem(days, itemId, days[t.d].dayId, index, joins ? block[0].group : undefined);
}

/** Drag-and-drop onto a day's end zone: own block at the end of that day. */
export function dropOnDayEnd(days: DayLayout[], itemId: string, dayId: string): DayLayout[] {
  return moveToDay(days, itemId, dayId);
}

/** Days whose item order, membership or blocks differ between two layouts (by normalized result). */
export function changedDays(before: DayLayout[], after: DayLayout[]): DayLayout[] {
  const key = (d: DayLayout | undefined) => (d ? JSON.stringify(normalizeDay(d.items).map((x) => [x.id, x.blockLabel, x.blockType])) : "");
  return after.filter((d) => key(d) !== key(before.find((b) => b.dayId === d.dayId)));
}
