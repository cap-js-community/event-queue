using EventQueueMonitoringService from '../../srv/service';

annotate EventQueueMonitoringService.Event with @(
//   UI.Identification            : [{
//     $Type             : 'UI.DataFieldForAction',
//     Label             : '{i18n>Cancel}',
//     Action            : 'SchedulingMonitoringService.cancel',
//     InvocationGrouping: #Isolated,
//     Criticality       : #Negative
//   }],
  UI.FieldGroup #General       : {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: ID,
      },
      {
        $Type: 'UI.DataField',
        Value: payload,
      },
      {
        $Type: 'UI.DataField',
        Value: referenceEntity,
      },
      {
        $Type: 'UI.DataField',
        Value: referenceEntityKey,
      },
      {
        $Type: 'UI.DataField',
        Value: status,
      },
    ],
  },
  UI.FieldGroup #Details       : {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: context,
      },
//       {
//         $Type: 'UI.DataFieldWithUrl',
//         Value: link,
//         Url  : link,
//       },
//       {
//         $Type: 'UI.DataField',
//         Value: testRun,
//       },
    ],
  },
  UI.FieldGroup #Administrative: {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: createdAt,
      },
      {
        $Type: 'UI.DataField',
        Value: startAfter,
      },
    ],
  },
//   UI.FieldGroup #Capabilities  : {
//     $Type: 'UI.FieldGroupType',
//     Data : [
//       {
//         $Type: 'UI.DataField',
//         Value: definition.supportsStartDateTime,
//       },
//       {
//         $Type: 'UI.DataField',
//         Value: definition.supportsTestRun,
//       }
//     ]
//   },
  UI.HeaderFacets              : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>General}',
      Target: '@UI.FieldGroup#General',
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Details}',
      Target: '@UI.FieldGroup#Details',
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Administrative}',
      Target: '@UI.FieldGroup#Administrative',
    }
  ],
//   UI.Facets                    : [
//     {
//       $Type : 'UI.ReferenceFacet',
//       Label : '{i18n>Parameters}',
//       Target: 'parameters/@UI.PresentationVariant'
//     },
//     {
//       $Type : 'UI.ReferenceFacet',
//       Label : '{i18n>Results}',
//       Target: 'results/@UI.PresentationVariant'
//     }
//   ],
  UI.LineItem                  : [
    {
      $Type: 'UI.DataField',
      Value: ID,
    },
    {
      $Type: 'UI.DataField',
      Value: type,
    },
    {
      $Type: 'UI.DataField',
      Value: subType,
    },
    {
      $Type: 'UI.DataField',
      Value: status,
    },
    {
      $Type: 'UI.DataField',
      Value: payload,
    },
  ],
  UI.HeaderInfo                : {
    $Type         : 'UI.HeaderInfoType',
    TypeName      : '{i18n>Job}',
    TypeNamePlural: '{i18n>Jobs}',
    Title         : {
      Label: '{i18n>Job}',
      Value: ID
    },
    Description   : {Value: type}
  },
  UI.PresentationVariant       : {
    Visualizations: ['@UI.LineItem'],
    SortOrder     : [{
      $Type     : 'Common.SortOrderType',
      Property  : createdAt,
      Descending: true
    }]
  },
  UI.SelectionFields           : [
    type,
    subType,
    status,
  ],
);

annotate EventQueueMonitoringService.Event {
  status      @Common.ValueListWithFixedValues: true  @Common.Text: status.name             @Common.TextArrangement: #TextFirst;
//   link        @HTML5.LinkTarget: '_blank';
//   definition  @ValueList                      : {
//     entity: 'JobDefinition',
//     type  : #Fixed
//   }                                                   @Common.Text: definition.description  @Common.TextArrangement: #TextFirst;
};

// annotate SchedulingMonitoringService.Job actions {
//   cancel  @Common.IsActionCritical  @Core.OperationAvailable: {$edmJson: {$Or: [
//     {$Eq: [
//       {$Path: 'in/status_code'},
//       'requested'
//     ]},
//     {$Eq: [
//       {$Path: 'in/status_code'},
//       'running'
//     ]}
//   ]}}
// };

// annotate SchedulingMonitoringService.Job with @(UI.LineItem.@UI.Criticality: criticality, );