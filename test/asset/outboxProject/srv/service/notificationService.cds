
using sap.eventqueue as db from '../../../../../db';

@impl: './service.js'
service NotificationService {
    action sendFiori(to: String, subject: String, body: String);

    entity Event as projection on db.Event;
}
