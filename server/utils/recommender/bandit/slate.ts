// What one logged ranking decision is, and the replay rules shared by serving and offline evaluation.
//
// A slate log is everything needed to recompute any policy's choice probabilities at every position of a
// decision that already happened: the base context, every candidate's action vector, the chosen order, the
// conditional propensity of each choice, and - once known - the reward at each position.
import { type ExclusionRule, remainingAfter } from "./exploration";
import { type ShelfKind, cardContext, shelfContext } from "./features";

export type SlateLevel = "shelf" | "card";

export interface SlateLog {
    level: SlateLevel,
    /** card decisions: the shelf they were made for */
    shelfKind: ShelfKind | null,
    /** the base context vector (CONTEXT_DIM) */
    context: Float64Array,
    /** one action vector per candidate (ACTION_DIM for cards, SHELF_ACTION_DIM for shelves) */
    actions: Float64Array[],
    /** stable id per candidate (card: item + explanation, shelf: the shelf id) */
    actionIds: string[],
    /** dedupe key per candidate: one item, several explanations, shown once */
    itemKeys: string[],
    /** chosen candidate per position */
    order: number[],
    /** propensity of each position's choice, conditional on the positions before it */
    propensities: number[],
    /** reward per position, null until the attribution window closes */
    rewards: (number | null)[],
    /** sample weight per position */
    confidences: number[]
}

export function exclusionByItemKey(itemKeys: readonly string[]): ExclusionRule {
    return (chosen, candidate) => itemKeys[chosen] === itemKeys[candidate];
}

/** the context vector the decision at `position` was scored with */
export function contextAt(log: Pick<SlateLog, "level" | "shelfKind" | "context">, position: number): Float64Array {
    if (log.level === "card") {
        if (!log.shelfKind) throw new Error("card slate without a shelf kind");
        return cardContext(log.context, log.shelfKind, position);
    }
    return shelfContext(log.context, position);
}

/** the candidates that were still available at `position` (indices into log.actions) */
export function remainingAt(log: Pick<SlateLog, "actions" | "itemKeys" | "order">, position: number): number[] {
    return remainingAfter(log.actions.length, log.order.slice(0, position), exclusionByItemKey(log.itemKeys));
}
