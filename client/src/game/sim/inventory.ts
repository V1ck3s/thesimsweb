/**
 * SimInventory (SimInventory.cpp): a neighbor's tokens (type, GUID, count),
 * kept by the Neighborhood (+400) and saved in its NGBH chunk. The data
 * lives in `data/neighborhood.ts` (SimInventory / SimInventoryToken); these
 * are the methods the Manage Inventory primitive calls.
 */

import type { SimInventory, SimInventoryToken } from "../data/neighborhood.js";

/** SimInventory::FindTokenIterator: index of the token of `type` with `guid`, or -1. */
function findTokenIterator(inv: SimInventory, type: number, guid: number): number {
  return inv.tokens.findIndex((t) => t.type === type && t.guid === guid);
}

/** SimInventory::CountTokensOfType */
export function countTokensOfType(inv: SimInventory, type: number): number {
  return inv.tokens.filter((t) => t.type === type).length;
}

/**
 * SimInventory::AddToken: a new token (at most 0x7fff of them), or the
 * existing one's count raised (capped at 0x7fff). A count of 0 does nothing.
 * Fails only when the list is full.
 */
export function addToken(inv: SimInventory, type: number, guid: number, count: number): boolean {
  if (count === 0) return true;
  const i = findTokenIterator(inv, type, guid);
  if (i < 0) {
    if (inv.tokens.length > 0x7ffe) return false;
    inv.tokens.push({ type, guid, count });
  } else {
    const t = inv.tokens[i]!;
    t.count = t.count + count < 0x7fff ? t.count + count : 0x7fff;
  }
  return true;
}

/**
 * SimInventory::RemoveToken: one off the token's count (whatever `count`
 * is, unless 0: nothing); the token goes when it reaches 0 or when `count`
 * is -1. Fails when there is no such token.
 */
export function removeToken(inv: SimInventory, type: number, guid: number, count: number): boolean {
  if (count === 0) return true;
  const i = findTokenIterator(inv, type, guid);
  if (i < 0) return false;
  const t = inv.tokens[i]!;
  t.count = t.count - 1 < 1 ? 0 : t.count - 1;
  if (t.count === 0 || count === -1) inv.tokens.splice(i, 1);
  return true;
}

/**
 * SimInventory::RemoveTokenByIndex: `count` off the token at `index`
 * (dropped at 0; a negative count drops it). Fails when the index is out
 * of range; a count of 0 does nothing.
 */
export function removeTokenByIndex(inv: SimInventory, index: number, count: number): boolean {
  if (count === 0) return true;
  if (index < 0 || index >= inv.tokens.length) return false;
  const kept: SimInventoryToken[] = [];
  inv.tokens.forEach((t, i) => {
    if (i !== index) {
      kept.push(t);
      return;
    }
    if (count < 0) return;
    t.count = t.count - count < 1 ? 0 : t.count - count;
    if (t.count > 0) kept.push(t);
  });
  inv.tokens = kept;
  return true;
}

/** SimInventory::RemoveAllTokensOfType */
export function removeAllTokensOfType(inv: SimInventory, type: number): void {
  inv.tokens = inv.tokens.filter((t) => t.type !== type);
}

/**
 * SimInventory::FindToken: the token's count (0 when missing) and its index
 * (-1 when missing).
 */
export function findToken(inv: SimInventory, type: number, guid: number): { count: number; index: number } {
  const i = findTokenIterator(inv, type, guid);
  return i < 0 ? { count: 0, index: -1 } : { count: inv.tokens[i]!.count, index: i };
}

/**
 * SimInventory::SetToNextToken: from index + 1, the next token of `type`
 * (and `guid` unless 0). Returns its count and index, or count 0 and index
 * -1 at the end.
 */
export function setToNextToken(inv: SimInventory, type: number, index: number, guid: number): { count: number; index: number } {
  // FindTokenIteratorByIndex: an index out of range (as unsigned) is the end.
  const start = ((index + 1) << 16) >> 16;
  if (start < 0) return { count: 0, index: -1 };
  for (let i = start; i < inv.tokens.length; i++) {
    const t = inv.tokens[i]!;
    if (t.type === type && (guid === 0 || t.guid === guid)) return { count: t.count, index: i };
  }
  return { count: 0, index: -1 };
}
