
using sap.eventqueue.sample.Task from '../../db/Task';

@impl: './../handler/process-service.js'
service ProcessService {
    entity C_ClosingTask as projection on Task
    actions {
        action trigger();
        action triggerSpecial();
    };

}
