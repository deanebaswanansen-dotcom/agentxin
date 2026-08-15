import { readFile } from 'node:fs/promises';

export type StructuredFixtureLocalExpectation =
  | 'accepted_direct'
  | 'accepted_local_repair'
  | 'parse_failed'
  | 'decode_failed';

export interface StructuredOutputFixtureDefinition {
  id: string;
  file: string;
  defect:
    | 'valid'
    | 'code_fence'
    | 'reasoning_pollution'
    | 'prose_pollution'
    | 'trailing_comma'
    | 'raw_control_character'
    | 'missing_delimiter'
    | 'truncation'
    | 'missing_quote'
    | 'single_quote'
    | 'unescaped_quote'
    | 'wrong_top_level'
    | 'no_json'
    | 'missing_field'
    | 'wrong_type';
  expectedLocal: StructuredFixtureLocalExpectation;
}

export interface StructuredOutputFixture extends StructuredOutputFixtureDefinition {
  raw: string;
}

export const STRUCTURED_OUTPUT_FIXTURES: readonly StructuredOutputFixtureDefinition[] = [
  { id: 'valid_plain', file: '01-valid-plain.txt', defect: 'valid', expectedLocal: 'accepted_direct' },
  { id: 'code_fence', file: '02-code-fence.txt', defect: 'code_fence', expectedLocal: 'accepted_direct' },
  { id: 'reasoning_tag', file: '03-reasoning-tag.txt', defect: 'reasoning_pollution', expectedLocal: 'accepted_direct' },
  { id: 'prose_wrapper', file: '04-prose-wrapper.txt', defect: 'prose_pollution', expectedLocal: 'accepted_direct' },
  { id: 'braces_in_string', file: '05-braces-in-string.txt', defect: 'valid', expectedLocal: 'accepted_direct' },
  { id: 'bracketed_reasoning', file: '06-bracketed-reasoning.txt', defect: 'reasoning_pollution', expectedLocal: 'accepted_direct' },
  { id: 'trailing_comma_object', file: '07-trailing-comma-object.txt', defect: 'trailing_comma', expectedLocal: 'accepted_local_repair' },
  { id: 'trailing_comma_array', file: '08-trailing-comma-array.txt', defect: 'trailing_comma', expectedLocal: 'accepted_local_repair' },
  { id: 'raw_newline', file: '09-raw-newline-in-string.txt', defect: 'raw_control_character', expectedLocal: 'accepted_local_repair' },
  { id: 'raw_tab', file: '10-raw-tab-in-string.txt', defect: 'raw_control_character', expectedLocal: 'accepted_local_repair' },
  { id: 'missing_right_brace', file: '11-missing-right-brace.txt', defect: 'missing_delimiter', expectedLocal: 'parse_failed' },
  { id: 'real_truncation', file: '12-real-truncation-mid-array.txt', defect: 'truncation', expectedLocal: 'parse_failed' },
  { id: 'unquoted_key', file: '13-unquoted-key.txt', defect: 'missing_quote', expectedLocal: 'parse_failed' },
  { id: 'single_quotes', file: '14-single-quotes.txt', defect: 'single_quote', expectedLocal: 'parse_failed' },
  { id: 'unescaped_inner_quote', file: '15-unescaped-inner-quote.txt', defect: 'unescaped_quote', expectedLocal: 'parse_failed' },
  { id: 'top_level_array', file: '16-top-level-array.txt', defect: 'wrong_top_level', expectedLocal: 'accepted_direct' },
  { id: 'no_json', file: '17-no-json.txt', defect: 'no_json', expectedLocal: 'parse_failed' },
  { id: 'reasoning_only', file: '18-reasoning-only.txt', defect: 'reasoning_pollution', expectedLocal: 'parse_failed' },
  { id: 'missing_hairstyle', file: '19-missing-required-field.txt', defect: 'missing_field', expectedLocal: 'decode_failed' },
  { id: 'aliases_wrong_type', file: '20-wrong-field-type.txt', defect: 'wrong_type', expectedLocal: 'decode_failed' },
] as const;

export async function loadStructuredOutputFixtures(): Promise<StructuredOutputFixture[]> {
  return Promise.all(STRUCTURED_OUTPUT_FIXTURES.map(async (fixture) => ({
    ...fixture,
    raw: await readFile(new URL(fixture.file, import.meta.url), 'utf8'),
  })));
}
