import type { BrowserDocumentApi } from 'superdoc';

declare const doc: BrowserDocumentApi;

const match = doc.query.match({
  select: { type: 'text', pattern: 'Confidential Information' },
  require: 'first',
});

void Promise.resolve(match).then((result) => {
  const revision: string = result.evaluatedRevision;
  const item = result.items[0];
  if (item?.matchKind === 'text' && item.target) {
    const receipt = doc.replace(
      { target: item.target, text: 'Confidential Information' },
      { changeMode: 'tracked', expectedRevision: revision },
    );
    void Promise.resolve(receipt).then((value) => {
      const success: boolean = value.success;
      void success;
    });
  }
});
