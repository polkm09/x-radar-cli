import { describe, expect, it } from 'vitest';
import { parseGetnoteSaveJson } from '../src/getnote-runner.js';

describe('getnote save output parsing', () => {
  it('extracts note_id from supported output shapes', () => {
    expect(parseGetnoteSaveJson('{"note_id":"n1"}').note_id).toBe('n1');
    expect(parseGetnoteSaveJson('{"id":"n2"}').note_id).toBe('n2');
    expect(parseGetnoteSaveJson('{"data":{"note_id":"n3"}}').note_id).toBe('n3');
    expect(parseGetnoteSaveJson('{"data":{"id":"n4"}}').note_id).toBe('n4');
    expect(parseGetnoteSaveJson('{"success":true,"data":{"note":{"id":1911305071435768360,"note_id":1911305071435768360}}}').note_id).toBe('1911305071435768360');
    expect(parseGetnoteSaveJson('{"success":true,"data":{"note":{"id":1911305071435768361}}}').note_id).toBe('1911305071435768361');
  });

  it('throws when JSON is invalid or note_id is missing', () => {
    expect(() => parseGetnoteSaveJson('not json')).toThrow(/parseable JSON/);
    expect(() => parseGetnoteSaveJson('{"ok":true}')).toThrow(/note_id/);
  });
});
