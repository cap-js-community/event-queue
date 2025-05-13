using sap.eventqueue as db from '../../db';

@path: 'event-queue/admin'
@impl: './admin-service.js'
service EventQueueAdminService {

  @readonly
  entity Event as projection on db.Event {
        null as tenantId: String,
        null as landscape: String,
        null as space: String,
        *
  } actions {
    action setStatusAndAttempts(status: db.Status,
    @assert.range: [0,100]
    attempts: Integer) returns Event;
  }
}
