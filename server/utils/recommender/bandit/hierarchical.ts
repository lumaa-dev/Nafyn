// Hierarchical ranking of a recommendation page: first the shelves (rows), then the cards inside each shelf.
//
//   1. every shelf's cards are scored once at position 0, so the shelf can be described by how good its best
//      cards are predicted to be (encodeShelf);
//   2. the shelf bandit orders the shelves, row by row, each row its own logged decision;
//   3. in row order, the card bandit fills each shelf position by position, each position its own logged
//      decision. The position is part of the card context, so every position re-scores what is left. An item
//      already placed on the page (in an earlier shelf, or earlier in this one with another explanation) is
//      excluded - by the same itemKey rule offline evaluation replays.
//
// The probability that a card ended up at (row r, slot j) is P(shelf at row r) * P(card at slot j | shelf);
// each factor is logged with its own decision, and the offline estimators evaluate each level on its own.
import type { Rng } from "../math";
import { type ExplorationSpec, type ScoreSampler, choosePosition } from "./exploration";
import type { Explanation } from "./explanations";
import { type FeatureSpace, type ShelfKind, cardContext, encodeShelf, shelfContext } from "./features";
import { type BanditPolicy, scoreActions } from "./score";
import { type SlateLog, remainingAt } from "./slate";

export interface CardCandidate {
    /** stable id of the (item, explanation) pair */
    actionId: string,
    /** one item, shown once per page */
    itemKey: string,
    /** encodeAction() of the pair */
    action: Float64Array,
    explanation: Explanation
}

export interface ShelfCandidate {
    id: string,
    kind: ShelfKind,
    cards: CardCandidate[],
    maxCards: number
}

export interface PolicyBundle {
    card: BanditPolicy,
    cardSpace: FeatureSpace,
    cardJoint: "linear" | "neural",
    shelf: BanditPolicy,
    shelfSpace: FeatureSpace
}

export interface RankOptions {
    exploration: ExplorationSpec,
    /** Thompson propensity estimation */
    mcSamples: number,
    propensityFloor: number,
    maxShelves: number,
    /** a shelf with fewer valid cards than this is not shown at all */
    minCardsPerShelf: number
}

export interface PlacedCard {
    candidate: CardCandidate,
    slot: number,
    propensity: number,
    mean: number,
    sigma: number,
    lambda: number
}

export interface PlacedShelf {
    shelf: ShelfCandidate,
    row: number,
    propensity: number,
    cards: PlacedCard[],
    /** the card decision of this shelf (null when no card was placed) */
    cardLog: SlateLog | null
}

export interface RankedPage {
    shelves: PlacedShelf[],
    shelfLog: SlateLog,
    /** wall-clock scoring time, for the latency budget */
    elapsedMs: number
}

export function samplerFor(policy: BanditPolicy, mean: Float64Array, sigma: Float64Array): ScoreSampler | undefined {
    return policy.stochastic ? { mean, sigma, nu: policy.nu ?? 1 } : undefined;
}

/** Scores and places one position of a slate. `contextFor(position)` gives that position's context. */
function placeOne(
    policy: BanditPolicy,
    space: FeatureSpace,
    joint: "linear" | "neural",
    log: SlateLog,
    position: number,
    contextVec: Float64Array,
    options: RankOptions,
    rng: Rng
): { index: number, propensity: number, mean: number, sigma: number, lambda: number } | null {
    const available = remainingAt(log, position);
    if (available.length === 0) return null;
    // only what is still available is scored; the rest keeps -Infinity and can never be chosen
    const xs = available.map((i) => space.joint(joint, contextVec, log.actions[i]!));
    const scored = scoreActions(policy, xs, rng);
    const n = log.actions.length;
    const scores = new Float64Array(n).fill(-Infinity);
    const mean = new Float64Array(n);
    const sigma = new Float64Array(n);
    const lambda = new Float64Array(n);
    available.forEach((i, j) => {
        scores[i] = scored.score[j]!;
        mean[i] = scored.mean[j]!;
        sigma[i] = scored.sigma[j]!;
        lambda[i] = scored.lambda[j]!;
    });
    const choice = choosePosition(scores, available, options.exploration, rng, {
        sampler: samplerFor(policy, mean, sigma),
        mcSamples: options.mcSamples,
        floor: options.propensityFloor
    });
    return {
        index: choice.index,
        propensity: choice.propensity,
        mean: mean[choice.index]!,
        sigma: sigma[choice.index]!,
        lambda: lambda[choice.index]!
    };
}

export function rankPage(baseContext: Float64Array, shelves: ShelfCandidate[], policies: PolicyBundle, options: RankOptions, rng: Rng): RankedPage {
    const started = performance.now();
    const eligible = shelves.filter((s) => uniqueItems(s.cards) >= Math.max(1, options.minCardsPerShelf));

    // 1. describe each shelf by its cards' predicted rewards at the shelf's first position
    const shelfActions = eligible.map((s) => {
        const ctx = cardContext(baseContext, s.kind, 0);
        const xs = s.cards.map((c) => policies.cardSpace.joint(policies.cardJoint, ctx, c.action));
        const { mean } = policies.card.predict(xs);
        return encodeShelf(s.kind, mean, s.cards.length);
    });

    // 2. order the shelves
    const shelfLog: SlateLog = {
        level: "shelf",
        shelfKind: null,
        context: baseContext,
        actions: shelfActions,
        actionIds: eligible.map((s) => s.id),
        itemKeys: eligible.map((s) => `shelf:${s.id}`),
        order: [],
        propensities: [],
        rewards: [],
        confidences: []
    };
    const rows = Math.min(options.maxShelves, eligible.length);
    for (let row = 0; row < rows; row++) {
        const placed = placeOne(policies.shelf, policies.shelfSpace, "linear", shelfLog, row, shelfContext(baseContext, row), options, rng);
        if (!placed) break;
        shelfLog.order.push(placed.index);
        shelfLog.propensities.push(placed.propensity);
        shelfLog.rewards.push(null);
        shelfLog.confidences.push(1);
    }

    // 3. fill each shelf, in row order, never repeating an item on the page
    const usedItems = new Set<string>();
    const placedShelves: PlacedShelf[] = [];
    shelfLog.order.forEach((shelfIndex, row) => {
        const shelf = eligible[shelfIndex]!;
        const candidates = shelf.cards.filter((c) => !usedItems.has(c.itemKey));
        const cardLog: SlateLog = {
            level: "card",
            shelfKind: shelf.kind,
            context: baseContext,
            actions: candidates.map((c) => c.action),
            actionIds: candidates.map((c) => c.actionId),
            itemKeys: candidates.map((c) => c.itemKey),
            order: [],
            propensities: [],
            rewards: [],
            confidences: []
        };
        const cards: PlacedCard[] = [];
        for (let slot = 0; slot < shelf.maxCards; slot++) {
            const placed = placeOne(policies.card, policies.cardSpace, policies.cardJoint, cardLog, slot, cardContext(baseContext, shelf.kind, slot), options, rng);
            if (!placed) break;
            cardLog.order.push(placed.index);
            cardLog.propensities.push(placed.propensity);
            cardLog.rewards.push(null);
            cardLog.confidences.push(1);
            const candidate = candidates[placed.index]!;
            usedItems.add(candidate.itemKey);
            cards.push({ candidate, slot, propensity: placed.propensity, mean: placed.mean, sigma: placed.sigma, lambda: placed.lambda });
        }
        placedShelves.push({
            shelf,
            row,
            propensity: shelfLog.propensities[row]!,
            cards,
            cardLog: cards.length ? cardLog : null
        });
    });

    return { shelves: placedShelves, shelfLog, elapsedMs: performance.now() - started };
}

function uniqueItems(cards: readonly CardCandidate[]): number {
    return new Set(cards.map((c) => c.itemKey)).size;
}
