import type { BestiaryRow, ItemDef, MoveDef, Nature, RuledBestiaryRow, SpeciesDef, TraitDef, TypeId } from '@daemonet/rules';

export type { BestiaryRow, ItemDef, MoveDef, SpeciesDef, TraitDef, TypeId };
/** A bestiary row as `/api/codex` serves it: with its requirement, masked (null) while hidden and undiscovered. */
export type CodexBestiaryRow = RuledBestiaryRow;
export type NatureDef = Nature;
