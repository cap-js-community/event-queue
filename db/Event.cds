namespace sap.eventqueue;

using cuid from '@sap/cds/common';

@sap.value.list: 'fixed-values'
type Status: Integer enum {
    Open = 0;
    InProgress = 1;
    Done = 2;
    Error = 3;
    Exceeded = 4;
}

entity Event: cuid {
    type: String not null;
    subType: String not null;
    referenceEntity: String;
    referenceEntityKey: UUID;
    status: Status default 0 not null;
    payload: LargeString;
    attempts: Integer default 0 not null;
    lastAttemptTimestamp: Timestamp;
    createdAt: Timestamp @cds.on.insert : $now;
    startAfter: Timestamp;
}
