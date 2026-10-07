/**
 * The published output schemas against the TypeScript types the commands print. The runs in
 * `test/output-schemas.test.ts` check what real output holds; this checks every field and
 * every value each type allows, including those no run happens to print. Each listing below
 * is checked complete and exact by the compiler, so a field added to a type fails to compile
 * here until the schema is updated too.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CoverageReport,
  type Edit,
  type EncodeFormat,
  type Finding,
  type OptimizationPlan,
  type OptimizeProgress,
  type OptimizeProjectResult,
  type PipelineProgress,
  type PlanRefusal,
  type PlannedConversion,
  type PlannedRewrite,
  REPORT_SCHEMA_VERSION,
  type ReferenceEntry,
  type ReferenceReport,
  type Report,
  type ReportSummary,
  type Resolution,
  type ServingRoots,
  type SkippedItem,
} from 'upfly-core';
import type { DedupeCopy, DedupePlan, DedupeSet, KeptBecause, StayingReference } from 'upfly-core';
import type { Move, MovePlan, RefusalCode, RefusedMove } from 'upfly-core/internal';
import type {
  Mention,
  ProbeDiagnostic,
  ScanDiagnostic,
  ServingRootDecision,
  UnfollowedReason,
  UnscannedExtension,
  Unsearchable,
} from 'upfly-core/internal';
import { describe, expect, it } from 'vitest';
import type { TooLargeFinding } from './check.js';
import type { Reason } from './init.js';
import type { MoveRun, UnfollowedOldPath } from './move.js';
import type { ReferenceAnswer, UnfollowedAnswer, Verdict } from './refs.js';
import type { Undone } from './undo.js';

type Schema = { readonly [keyword: string]: unknown };

const SCHEMA_DIR = fileURLToPath(new URL('../schema/', import.meta.url));
const schemas: Record<string, Schema> = Object.fromEntries(
  readdirSync(SCHEMA_DIR).map((file) => [
    file,
    JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')),
  ]),
);

/** Whether a field may be left out. */
type Presence<T, K extends keyof T> = object extends Pick<T, K> ? 'optional' : 'required';
type Fields<T> = { readonly [K in keyof T]-?: Presence<T, K> };
/** Every member of a union of strings, listed once. */
type Members<T extends string> = { readonly [K in T]: true };

/** Every field of `T` with whether it is optional; the compiler checks the list. */
function fields<T>(listing: Fields<T>): Record<string, string> {
  return listing as Record<string, string>;
}

function members<T extends string>(listing: Members<T>): string[] {
  return Object.keys(listing).sort();
}

/** The schema at `pointer` in `file`, following each `$ref` on the way, into other files too. */
function at(file: string, pointer: string): Schema {
  let here = follow(schemas[file] as Schema, file);
  for (const segment of pointer.split('/').filter((part) => part !== '')) {
    const next = here.node[segment];
    if (next === undefined) throw new Error(`${file}#${pointer}: nothing at ${segment}`);
    here = follow(next as Schema, here.file);
  }
  return here.node;
}

function follow(node: Schema, file: string): { node: Schema; file: string } {
  let current = { node, file };
  while (typeof current.node.$ref === 'string') {
    const [target, fragment = ''] = current.node.$ref.split('#');
    const into = target === '' || target === undefined ? current.file : target;
    let resolved = schemas[into] as Schema;
    for (const segment of fragment.split('/').filter((part) => part !== '')) {
      resolved = resolved[segment] as Schema;
    }
    current = { node: resolved, file: into };
  }
  return current;
}

/** The object branch of a schema that also allows null. */
function objectOf(schema: Schema): Schema {
  const branches = schema.oneOf as Schema[] | undefined;
  return branches?.find((branch) => branch.type !== 'null') ?? schema;
}

function expectFields(schema: Schema, listing: Record<string, string>, leaveOut: string[] = []) {
  const object = objectOf(schema);
  const properties = Object.keys(object.properties as Schema).filter(
    (key) => !leaveOut.includes(key),
  );
  const required = ((object.required as string[] | undefined) ?? []).filter(
    (key) => !leaveOut.includes(key),
  );
  expect(properties.sort()).toEqual(Object.keys(listing).sort());
  expect(required.sort()).toEqual(
    Object.keys(listing)
      .filter((key) => listing[key] === 'required')
      .sort(),
  );
  expect(object.additionalProperties).toBe(false);
}

function enumOf(schema: Schema): string[] {
  return [...(schema.enum as string[])].sort();
}

/** The `const` of `key` in each branch of the `oneOf` at `pointer` in `file`. */
function constsOf(file: string, pointer: string, key: string): string[] {
  return (at(file, pointer).oneOf as Schema[])
    .map((branch) => (objectOf(follow(branch, file).node).properties as Schema)[key] as Schema)
    .map((property) => property.const as string)
    .sort();
}

type Of<T, K> = Extract<T, { kind: K }>;
type UnusedVector = NonNullable<Report['unusedVectors']['assets']>[number];
type DeclinedValues = ReferenceReport['declinedValues'];

describe('the report schema and the Report type agree', () => {
  it('pins the report version', () => {
    expect(at('report.json', '/properties/version').const).toBe(REPORT_SCHEMA_VERSION);
    expect(schemas['report.json']?.title).toBe(`Upfly report, version ${REPORT_SCHEMA_VERSION}`);
  });

  it('has every field of every part of the report, and whether each is optional', () => {
    const r = 'report.json';
    expectFields(
      at(r, ''),
      fields<Report>({
        version: 'required',
        summary: 'required',
        findings: 'required',
        unusedVectors: 'required',
        keptOriginals: 'required',
        declined: 'required',
        declinedReferences: 'required',
        staleConversions: 'required',
        references: 'required',
        coverage: 'required',
        skipped: 'required',
        diagnosticsFile: 'required',
        caveats: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/summary'),
      fields<ReportSummary>({
        assets: 'required',
        assetBytes: 'required',
        sourceFiles: 'required',
        references: 'required',
        linkedReferences: 'required',
        referencedAssets: 'required',
        findings: 'required',
        potentialSavingBytes: 'required',
        savingQuality: 'required',
        probed: 'required',
        unmeasuredAssets: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/summary/properties/findings'),
      fields<ReportSummary['findings']>({
        'serving-root-unknown': 'required',
        broken: 'required',
        dead: 'required',
        'possibly-dead': 'required',
        oversized: 'required',
        'format-opportunity': 'required',
        duplicate: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/summary/properties/savingQuality'),
      fields<ReportSummary['savingQuality']>({ webp: 'optional', avif: 'optional' }),
    );
    expectFields(
      at(r, '/definitions/deadFinding'),
      fields<Of<Finding, 'dead'>>({
        kind: 'required',
        asset: 'required',
        bytes: 'required',
        inPublicDir: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/possiblyDeadFinding'),
      fields<Of<Finding, 'possibly-dead'>>({
        kind: 'required',
        asset: 'required',
        bytes: 'required',
        inPublicDir: 'required',
        evidence: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/brokenFinding'),
      fields<Of<Finding, 'broken'>>({
        kind: 'required',
        file: 'required',
        line: 'required',
        where: 'required',
        rawPath: 'required',
        note: 'optional',
      }),
    );
    expectFields(
      at(r, '/definitions/servingRootUnknownFinding'),
      fields<Of<Finding, 'serving-root-unknown'>>({
        kind: 'required',
        linked: 'required',
        checkable: 'required',
        suppressedBroken: 'required',
        suppressed: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/suppressedBroken'),
      fields<Of<Finding, 'serving-root-unknown'>['suppressed'][number]>({
        file: 'required',
        line: 'required',
        where: 'required',
        rawPath: 'required',
        note: 'optional',
      }),
    );
    expectFields(
      at(r, '/definitions/oversizedFinding'),
      fields<Of<Finding, 'oversized'>>({
        kind: 'required',
        asset: 'required',
        bytes: 'required',
        width: 'required',
        height: 'required',
        exceeded: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/formatOpportunityFinding'),
      fields<Of<Finding, 'format-opportunity'>>({
        kind: 'required',
        asset: 'required',
        from: 'required',
        to: 'required',
        bytes: 'required',
        wouldBe: 'required',
        savedBytes: 'required',
        savedPercent: 'required',
        quality: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/duplicateFinding'),
      fields<Of<Finding, 'duplicate'>>({
        kind: 'required',
        assets: 'required',
        bytes: 'required',
        wastedBytes: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/mention'),
      fields<Mention>({
        asset: 'required',
        source: 'required',
        where: 'required',
        quote: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/unusedVector/oneOf/0'),
      fields<Of<UnusedVector, 'dead'>>({ kind: 'required', asset: 'required', bytes: 'required' }),
    );
    expectFields(
      at(r, '/definitions/unusedVector/oneOf/1'),
      fields<Of<UnusedVector, 'possibly-dead'>>({
        kind: 'required',
        asset: 'required',
        bytes: 'required',
        evidence: 'required',
      }),
    );
    for (const name of ['unusedVectors', 'keptOriginals', 'declined'] as const) {
      expectFields(
        at(r, `/properties/${name}`),
        fields<Report['unusedVectors' | 'keptOriginals' | 'declined']>({
          count: 'required',
          bytes: 'required',
          assets: 'required',
        }),
      );
    }
    expectFields(
      at(r, '/properties/keptOriginals/properties/assets/items'),
      fields<Report['keptOriginals']['assets'][number]>({
        asset: 'required',
        bytes: 'required',
        convertedTo: 'required',
      }),
    );
    expectFields(
      at(r, '/properties/declined/properties/assets/oneOf/1/items'),
      fields<NonNullable<Report['declined']['assets']>[number]>({
        asset: 'required',
        bytes: 'required',
        reason: 'required',
      }),
    );
    expectFields(
      at(r, '/properties/declinedReferences'),
      fields<Report['declinedReferences']>({ count: 'required', references: 'required' }),
    );
    expectFields(
      at(r, '/properties/declinedReferences/properties/references/oneOf/1/items'),
      fields<NonNullable<Report['declinedReferences']['references']>[number]>({
        file: 'required',
        line: 'required',
        reason: 'required',
      }),
    );
    expectFields(
      at(r, '/properties/staleConversions/items'),
      fields<Report['staleConversions'][number]>({
        vector: 'required',
        rawPath: 'required',
        where: 'required',
      }),
    );
    expectFields(
      at(r, '/properties/skipped/items'),
      fields<SkippedItem>({ what: 'required', stage: 'required', reason: 'required' }),
    );
    expectFields(
      at(r, '/properties/caveats/items'),
      fields<Report['caveats'][number]>({
        code: 'required',
        count: 'required',
        message: 'required',
        detail: 'required',
      }),
    );
  });

  it('has every field of the references and the coverage', () => {
    const r = 'report.json';
    expectFields(
      at(r, '/definitions/references'),
      fields<ReferenceReport>({
        byResolution: 'required',
        byConfidence: 'required',
        byResolvedVia: 'required',
        byClassification: 'required',
        refusalAccuracyIsNotSelfAssessable: 'required',
        classificationBounds: 'required',
        unsafe: 'required',
        leftOut: 'required',
        discardedCount: 'required',
        discarded: 'required',
        declinedValues: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/byResolution'),
      fields<ReferenceReport['byResolution']>({
        resolved: 'required',
        'resolved-pattern': 'required',
        dynamic: 'required',
        'out-of-scope': 'required',
        broken: 'required',
        discarded: 'required',
        'unresolved-alias': 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/byConfidence'),
      fields<ReferenceReport['byConfidence']>({
        certain: 'required',
        high: 'required',
        medium: 'required',
        unsafe: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/byResolvedVia'),
      fields<ReferenceReport['byResolvedVia']>({
        file: 'required',
        'serving-root': 'required',
        'project-root': 'required',
        'speculative-root': 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/byClassification'),
      fields<ReferenceReport['byClassification']>({
        'resolved-with-an-answer': 'required',
        'missed-with-an-answer': 'required',
        'correctly-refused': 'required',
        'not-a-claim': 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/classificationBounds/items'),
      fields<ReferenceReport['classificationBounds'][number]>({
        reason: 'required',
        count: 'required',
        bound: 'required',
        measuredAgainst: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/referenceEntry'),
      fields<ReferenceEntry>({
        file: 'required',
        rawPath: 'required',
        resolution: 'required',
        reason: 'required',
        classification: 'required',
        refusalReason: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/references/properties/declinedValues'),
      fields<DeclinedValues>({ count: 'required', byReason: 'required', values: 'required' }),
    );
    expectFields(
      at(r, '/definitions/references/properties/declinedValues/properties/byReason/items'),
      fields<DeclinedValues['byReason'][number]>({ reason: 'required', count: 'required' }),
    );
    expectFields(
      at(r, '/definitions/references/properties/declinedValues/properties/values/oneOf/1/items'),
      fields<NonNullable<DeclinedValues['values']>[number]>({
        file: 'required',
        rawPath: 'required',
        reason: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/coverage'),
      fields<CoverageReport>({
        unscannedExtensions: 'required',
        unscannedFileCount: 'required',
        excludedRoots: 'required',
        servingRoots: 'required',
        notExercised: 'required',
      }),
    );
    expectFields(
      at(r, '/definitions/coverage/properties/unscannedExtensions/items'),
      fields<UnscannedExtension>({ ext: 'required', fileCount: 'required' }),
    );
    expectFields(
      at(r, '/definitions/coverage/properties/excludedRoots/items'),
      fields<CoverageReport['excludedRoots'][number]>({ path: 'required', reason: 'required' }),
    );
    expectFields(
      at(r, '/definitions/coverage/properties/servingRoots'),
      fields<ServingRoots>({ dirs: 'required', declared: 'required' }),
    );
    expectFields(
      at(r, '/definitions/coverage/properties/notExercised/items'),
      fields<CoverageReport['notExercised'][number]>({ mechanism: 'required', why: 'required' }),
    );
  });

  it('has every value of every closed list in the report', () => {
    const r = 'report.json';
    expect(constsOf(r, '/definitions/finding', 'kind')).toEqual(
      members<Finding['kind']>({
        dead: true,
        'possibly-dead': true,
        broken: true,
        'serving-root-unknown': true,
        oversized: true,
        'format-opportunity': true,
        duplicate: true,
      }),
    );
    expect(enumOf(at(r, '/definitions/resolution'))).toEqual(
      members<Resolution>({
        resolved: true,
        'resolved-pattern': true,
        dynamic: true,
        'out-of-scope': true,
        broken: true,
        discarded: true,
        'unresolved-alias': true,
      }),
    );
    expect(enumOf(at(r, '/definitions/classification'))).toEqual(
      members<ReferenceEntry['classification']>({
        'resolved-with-an-answer': true,
        'missed-with-an-answer': true,
        'correctly-refused': true,
        'not-a-claim': true,
      }),
    );
    expect(enumOf(at(r, '/definitions/mention/properties/source'))).toEqual(
      members<Mention['source']>({
        'unscanned-file': true,
        'unresolved-reference': true,
        'scanned-file': true,
      }),
    );
    expect(enumOf(at(r, '/properties/skipped/items/properties/stage'))).toEqual(
      members<SkippedItem['stage']>({
        discovery: true,
        scan: true,
        sweep: true,
        citation: true,
        measurement: true,
        aliases: true,
      }),
    );
    expect(enumOf(at(r, '/properties/caveats/items/properties/code'))).toEqual(
      members<Report['caveats'][number]['code']>({
        'public-dir-dead': true,
        'framework-conventions': true,
        'nothing-to-measure': true,
        'not-probed': true,
        'duplicates-not-checked': true,
        'encode-capped': true,
        'excluded-roots': true,
        'replace-held-back': true,
        'unscanned-extensions': true,
        'binary-file-types': true,
        'svg-both-ways': true,
        'unused-vectors': true,
      }),
    );
    expect(enumOf(at(r, '/definitions/oversizedFinding/properties/exceeded/items'))).toEqual(
      members<Of<Finding, 'oversized'>['exceeded'][number]>({
        bytes: true,
        width: true,
        height: true,
      }),
    );
    expect(enumOf(at(r, '/definitions/format'))).toEqual(
      members<EncodeFormat>({ webp: true, avif: true }),
    );
  });
});

describe('the command schemas and the types each command prints agree', () => {
  it('optimize and dedupe: the plans', () => {
    const o = 'optimize.json';
    expectFields(
      at(o, '/definitions/plan'),
      fields<OptimizationPlan>({
        conversions: 'required',
        rewrites: 'required',
        declined: 'required',
        keptOriginals: 'required',
        refusal: 'required',
      }),
    );
    expectFields(
      at(o, '/definitions/conversion'),
      fields<PlannedConversion>({
        asset: 'required',
        target: 'required',
        format: 'required',
        quality: 'required',
        savedBytes: 'required',
        replacesOriginal: 'required',
      }),
    );
    expectFields(
      at(o, '/definitions/rewrite'),
      fields<PlannedRewrite>({ file: 'required', edits: 'required', textHash: 'optional' }),
    );
    expectFields(
      at(o, '/definitions/edit'),
      fields<Edit>({
        start: 'required',
        end: 'required',
        replacement: 'required',
        expected: 'optional',
        inComment: 'optional',
      }),
    );
    expectFields(
      at(o, '/definitions/plan/properties/declined/items'),
      fields<OptimizationPlan['declined'][number]>({
        path: 'required',
        line: 'required',
        reason: 'required',
      }),
    );
    expectFields(
      at(o, '/definitions/plan/properties/keptOriginals/items'),
      fields<OptimizationPlan['keptOriginals'][number]>({ asset: 'required', reason: 'required' }),
    );
    expectFields(
      at(o, '/definitions/plan/properties/refusal'),
      fields<PlanRefusal>({
        code: 'required',
        reason: 'required',
        linked: 'required',
        checkable: 'required',
      }),
    );
    expectFields(
      at(o, '/properties/only'),
      fields<NonNullable<OptimizeProjectResult['only']>>({
        images: 'required',
        unmatched: 'required',
      }),
    );

    const d = 'dedupe.json';
    expectFields(
      at(d, '/properties/plan'),
      fields<DedupePlan>({ sets: 'required', rewrites: 'required' }),
    );
    expectFields(
      at(d, '/definitions/set'),
      fields<DedupeSet>({
        keep: 'required',
        kept: 'required',
        bytes: 'required',
        copies: 'required',
      }),
    );
    expectFields(
      at(d, '/definitions/copy'),
      fields<DedupeCopy>({
        path: 'required',
        references: 'required',
        moved: 'required',
        stays: 'required',
        unusedAfter: 'required',
      }),
    );
    expectFields(
      at(d, '/definitions/copy/properties/stays/items'),
      fields<StayingReference>({
        file: 'required',
        line: 'required',
        where: 'required',
        text: 'required',
        why: 'required',
      }),
    );
    expect(enumOf(at(d, '/definitions/set/properties/kept'))).toEqual(
      members<KeptBecause>({
        chosen: true,
        'most-used': true,
        served: true,
        shorter: true,
        first: true,
      }),
    );
  });

  it('move: the plan, the run, and each list', () => {
    const m = 'move.json';
    expectFields(
      at(m, '/properties/plan'),
      fields<MovePlan>({
        moves: 'required',
        rewrites: 'required',
        refused: 'required',
        declined: 'required',
        unfollowed: 'required',
      }),
    );
    expectFields(at(m, '/definitions/move'), fields<Move>({ from: 'required', to: 'required' }));
    expectFields(
      at(m, '/definitions/refused'),
      fields<RefusedMove>({
        from: 'required',
        to: 'required',
        code: 'required',
        reason: 'required',
      }),
    );
    expect(enumOf(at(m, '/definitions/refused/properties/code'))).toEqual(
      members<RefusalCode>({
        'outside-project': true,
        'crosses-serving-boundary': true,
        'binds-a-pattern': true,
        'destination-occupied': true,
        'destination-claimed-twice': true,
        'source-claimed-twice': true,
        'rewrite-would-miss': true,
        'redirects-a-reference': true,
        'not-an-asset': true,
      }),
    );
    expectFields(
      at(m, '/definitions/declined'),
      fields<StayingReference>({
        file: 'required',
        line: 'required',
        where: 'required',
        text: 'required',
        why: 'required',
      }),
    );
    expectFields(
      at(m, '/definitions/unfollowed'),
      fields<UnfollowedOldPath>({
        from: 'required',
        file: 'required',
        line: 'required',
        text: 'required',
        reason: 'required',
        why: 'required',
        loads: 'required',
        host: 'optional',
      }),
    );
    expect(enumOf(at(m, '/definitions/unfollowed/properties/reason'))).toEqual(
      enumOf(at('refs.json', '/properties/unfollowed/items/properties/reason')),
    );
    expectFields(
      at(m, '/properties/run'),
      fields<MoveRun>({ id: 'required', moved: 'required', changed: 'required' }),
    );
  });

  it('undo, check, refs and init', () => {
    expectFields(
      at('undo.json', '/properties/undone'),
      fields<Undone>({
        id: 'required',
        startedAt: 'required',
        restored: 'required',
        reverted: 'required',
        removed: 'required',
        moved: 'required',
      }),
    );
    expectFields(
      at('check.json', '/definitions/tooLargeFinding'),
      fields<TooLargeFinding>({ kind: 'required', asset: 'required', bytes: 'required' }),
    );
    expectFields(
      at('refs.json', '/properties/references/items'),
      fields<ReferenceAnswer>({
        file: 'required',
        line: 'required',
        text: 'required',
        rewritable: 'required',
        why: 'optional',
      }),
    );
    expectFields(
      at('refs.json', '/properties/unfollowed/items'),
      fields<UnfollowedAnswer>({
        file: 'required',
        line: 'required',
        text: 'required',
        reason: 'required',
        why: 'required',
        loads: 'required',
        host: 'optional',
      }),
    );
    expect(enumOf(at('refs.json', '/properties/unfollowed/items/properties/reason'))).toEqual(
      members<UnfollowedReason>({
        'full-address': true,
        'built-at-runtime': true,
        'data-or-props': true,
        'unread-file-type': true,
        comment: true,
        folder: true,
        other: true,
      }),
    );
    expectFields(
      at('refs.json', '/properties/unsearchable/items'),
      fields<Unsearchable>({ file: 'required', reason: 'required' }),
    );
    expect(constsOf('refs.json', '/properties/verdict', 'kind')).toEqual(
      members<Verdict['kind']>({
        converts: true,
        'not-converted': true,
        unused: true,
        'possibly-unused': true,
      }),
    );
    const verdicts = at('refs.json', '/properties/verdict').oneOf as Schema[];
    const [converts, notConverted, unused, possiblyUnused] = verdicts as [
      Schema,
      Schema,
      Schema,
      Schema,
    ];
    expectFields(
      converts,
      fields<Of<Verdict, 'converts'>>({
        kind: 'required',
        to: 'required',
        savedBytes: 'required',
        removesOriginal: 'required',
      }),
    );
    expectFields(
      notConverted,
      fields<Of<Verdict, 'not-converted'>>({ kind: 'required', why: 'required' }),
    );
    expectFields(unused, fields<Of<Verdict, 'unused'>>({ kind: 'required' }));
    expectFields(
      possiblyUnused,
      fields<Of<Verdict, 'possibly-unused'>>({ kind: 'required', mentions: 'required' }),
    );
    expectFields(
      at('refs.json', '/properties/verdict/oneOf/3/properties/mentions/items'),
      fields<Of<Verdict, 'possibly-unused'>['mentions'][number]>({
        where: 'required',
        quote: 'required',
      }),
    );
    expectFields(
      at('init.json', '/properties/reasons/items'),
      fields<Reason>({ setting: 'required', value: 'required', why: 'required' }),
    );
    expect(enumOf(at('init.json', '/properties/reasons/items/properties/setting'))).toEqual(
      members<Reason['setting']>({ publicDirs: true, format: true }),
    );
    expectFields(
      at('init.json', '/properties/ties/items'),
      fields<ServingRootDecision['inferred']['ties'][number]>({
        dir: 'required',
        candidates: 'required',
      }),
    );
  });

  it('the progress and diagnostic lines', () => {
    type Stage = PipelineProgress | OptimizeProgress;
    type StageOf<S> = Extract<Stage, { stage: S }>;
    const line = ['type', 'command'];
    const progress = at('events.json', '/definitions/progress').oneOf as Schema[];
    expect(constsOf('events.json', '/definitions/progress', 'stage')).toEqual(
      members<Stage['stage']>({
        discovered: true,
        scanned: true,
        resolved: true,
        measuring: true,
        measured: true,
        audited: true,
        planned: true,
        written: true,
      }),
    );
    const listings: Record<Stage['stage'], Record<string, string>> = {
      discovered: fields<StageOf<'discovered'>>({
        stage: 'required',
        images: 'required',
        files: 'required',
      }),
      scanned: fields<StageOf<'scanned'>>({ stage: 'required', references: 'required' }),
      resolved: fields<StageOf<'resolved'>>({ stage: 'required', linked: 'required' }),
      measuring: fields<StageOf<'measuring'>>({
        stage: 'required',
        done: 'required',
        total: 'required',
      }),
      measured: fields<StageOf<'measured'>>({ stage: 'required', images: 'required' }),
      audited: fields<StageOf<'audited'>>({ stage: 'required', findings: 'required' }),
      planned: fields<StageOf<'planned'>>({
        stage: 'required',
        conversions: 'required',
        rewrites: 'required',
      }),
      written: fields<StageOf<'written'>>({ stage: 'required', files: 'required' }),
    };
    for (const branch of progress) {
      const stage = ((branch.properties as Schema).stage as Schema).const as Stage['stage'];
      expectFields(branch, listings[stage], line);
    }

    const [image, parser] = (at('events.json', '/definitions/diagnostic').oneOf ?? []) as [
      Schema,
      Schema,
    ];
    expectFields(
      image,
      fields<ProbeDiagnostic>({
        asset: 'required',
        measurement: 'required',
        code: 'required',
        detail: 'required',
      }),
      [...line, 'source'],
    );
    expect(enumOf((image.properties as Schema).code as Schema)).toEqual(
      members<ProbeDiagnostic['code']>({
        'not-an-image': true,
        'svg-unreadable': true,
        'too-large-to-encode': true,
        'encode-failed': true,
      }),
    );
    expect(enumOf((image.properties as Schema).measurement as Schema)).toEqual(
      members<ProbeDiagnostic['measurement']>({ metadata: true, webp: true, avif: true }),
    );
    expectFields(
      parser,
      fields<ScanDiagnostic>({ relative: 'required', adapterId: 'required', detail: 'required' }),
      [...line, 'source'],
    );
  });
});
