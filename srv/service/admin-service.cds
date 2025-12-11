using sap.eventqueue as db from '../../db';

@path: 'event-queue/admin'
@requires: 'internal-user'
service EventQueueAdminService {

  @readonly
  @cds.persistence.skip
  entity Event as projection on db.Event {
        null as tenant: String,
        *
  } actions {
      action setStatusAndAttempts(
        status: db.Status,
        @assert.range: [0,100]
        attempts: Integer) returns Event;
    }

  @cds.persistence.skip
  @readonly
  entity Lock {
    key namespace: String;
    key tenant: String;
    key type: String;
    key subType: String;
    ttl: Integer;
    createdAt: Integer;
  } actions {
      action releaseLock(
        @mandatory
        type: String,
        @mandatory
        subType: String) returns Boolean;
    }

      action publishEvent(
          @mandatory
          namespace: String,
          @mandatory
          tenants: array of String,
          @mandatory
          type: String,
          @mandatory
          subType: String,
          referenceEntity: String,
          referenceEntityKey: String,
          payload: String,
          startAfter: String,
             );
}
