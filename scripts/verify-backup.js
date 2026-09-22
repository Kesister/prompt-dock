// Runs only within the isolated Electron smoke profile; never logs library content.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
module.exports = function verifyBackup(api, file, directory) {
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const incoming = api.loadPromptDockFile(file);
  const initial = api.readState();
  const merged = api.mergeImportedPrompts([], incoming.prompts);
  assert.equal(merged.conflicts.length, 0);
  const vocabulary = api.mergeVocabulary({ collections: [], entries: [], settings: {} }, incoming.vocabulary).vocabulary;
  api.writeState({ ...initial, prompts: merged.merged, vocabulary });
  const stored = api.readState();
  const exportFile = path.join(directory, 'roundtrip.promptdock');
  api.createPromptDockArchive(stored, exportFile);
  const restored = api.loadPromptDockFile(exportFile);
  for (const expected of incoming.prompts) {
    const actual = restored.prompts.find(p => p.id === expected.id);
    assert.ok(actual, 'prompt id preserved');
    assert.deepEqual(actual, expected, 'all prompt metadata and original image bytes preserved');
  }
  assert.equal(restored.prompts.length, incoming.prompts.length);
  const vocabKey = (v) => v.entries.map(e => ({ ...e, id: undefined,
    collectionId: v.collections.find(c => c.id === e.collectionId)?.name })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(vocabKey(restored.vocabulary), vocabKey(incoming.vocabulary));
  const twice = api.mergeImportedPrompts(stored.prompts, incoming.prompts);
  assert.equal(twice.summary.added, 0);
  assert.equal(twice.conflicts.length, 0);
  const twiceVocab = api.mergeVocabulary(stored.vocabulary, incoming.vocabulary);
  assert.equal(twiceVocab.summary.vocabularyEntriesAdded, 0);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
  api.writeState(initial);
  return { passed: true, prompts: incoming.prompts.length,
    trash: incoming.prompts.filter(p => p.deletedAt).length,
    images: incoming.prompts.reduce((n,p) => n + p.images.length, 0),
    variants: incoming.prompts.reduce((n,p) => n + p.variants.length, 0),
    tags: new Set(incoming.prompts.flatMap(p => p.tags)).size,
    vocabularyEntries: incoming.vocabulary.entries.length,
    vocabularyCollections: incoming.vocabulary.collections.length,
    sourceUnchanged: true, repeatedImportIdempotent: true };
};
