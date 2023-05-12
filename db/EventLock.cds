namespace sap.eventQueue;

using cuid from '@sap/cds/common';
using managed from '@sap/cds/common';

@cds.persistence.journal
@assert.unique.semanticKey: [code]
entity EventLock: managed {
    code: String not null;
    value: String;
}
