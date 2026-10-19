// Every id the mock publishes, as fixed UUIDs, so a buyer app's cached catalogue and the flows stay
// valid across deploys. The keys (P1, I1, L1, P1_F1, discp10, ...) are short labels for people: the
// playground, docs and comments show them; payloads carry only the UUIDs.
//
// Not UUIDs, per the contract: variant group ids (V1...; alphanumeric, up to 12) and order ids
// (alphanumeric, up to 32), which the buyer app issues anyway.
export const ID = {
  P1: '5189c211-71f4-481e-b6ee-b321ed330911',
  P2: '9f4a2727-23f8-42dc-a5ab-3523442e0b4d',
  P3: '50d9bcd0-0372-48ba-99d8-ae98cb1ebf9b',
  I1: '21f4a288-d154-4939-bac5-5b3741581360',
  I2: 'f2b8c564-2081-4a86-bf18-7548aa872685',
  I3: 'c7c0fce8-4ac8-419b-8a1a-1d89b1519b71',
  I4: 'adcb6cd6-9fc4-4fd9-a125-4a755df542b6',
  I5: '8acf9a32-4270-4ddc-9340-06cf165c5c18',
  I6: 'dccaa8e5-3762-413e-9265-ef49fc3d097a',
  I7: '4f3a84b8-2729-41e7-8d8e-555d21bd0a18',
  I8: '7fdd0b55-3bcd-4b3c-ab59-00002fe18d35',
  I9: '8acbd17e-a176-4a5b-9fee-dee3ce47a55a',
  I10: 'f59f259b-8c2e-4d42-94bb-6ff58dc23435',
  I11: 'dd48a334-575a-4be1-bfd2-e828a4e075d5',
  I12: '7b3f1393-a68e-4a77-b3e8-c71d778d834a',
  I13: '133b4b1b-cf4c-48b8-aed9-a51a6974b776',
  I14: 'aa682a09-f82c-430b-a87b-79a91c238fee',
  I15: 'b20048b8-d7af-4110-9727-399aa74c9392',
  I16: 'b1a53371-4915-442b-93c9-c325377fb0fd',
  I17: '3353a820-d55c-4880-a0d1-095148d8f13c',
  I18: '889995a9-8e43-4a43-aee2-7ce55e5aefc2',
  I19: 'fed4c1db-a818-461b-bcc3-98035840ed2a',
  I20: '4710956a-2c7d-46b2-997a-e0fab41fc717',
  L1: 'fab0e8e6-ca01-4702-90d3-2533eeba26fd',
  L2: '7d747b64-9a96-4d69-8d7e-d527fc1eca00',
  L3: 'b91ab6c1-edd1-450a-9b97-7cd634248d35',
  L4: '69d13a11-989a-4b6c-a470-995ceaf5967a',
  P1_F1: 'da189214-22f6-40c9-9e12-ee075d550805',
  P1_F2: '4aef76c4-f37d-4372-82e7-d835cbc7c590',
  P2_F1: 'ed803554-dde1-44f0-9c17-31f96f95f651',
  P3_F1: '3a283b1c-8747-45e8-b9af-9da7240ffa5b',
  discp10: 'c573cc91-dd11-4bb6-9017-b7247be4ad0f',
  slab1: 'c2f3d775-cb51-421a-bbe9-c3ee06cbfbfe',
  slab2: '03c1de8f-750f-438f-869f-513144796180',
  freebie1: '3f820ceb-b197-4e43-ab23-26f0da1baaa1',
  combo1: '5a4490c0-c89b-451b-b94c-1b0eb01f3f4d',
  flat50: 'afa93699-d688-4e54-bd45-fad7700eacd2',
  expired1: '804b7685-1a21-47e8-90f2-b44cb9ce9a56',
  flat150: 'b4a75fcb-1161-4837-ae9b-c2f9ab9d8a64',
  slabw1: '265f932d-f781-4246-adcf-fe6676af71bc',
  slabw2: 'ba43267d-2552-4dc5-a118-775b6314d1a8',
  disc5: '41db35e8-aba8-4d1d-8cb8-1ff1affd5242',
  excl300: '0d1bcfa8-ae9c-43b9-8a42-4ac0b6496105',
  buy2get1: 'bf13df81-6226-4fb5-a752-057fe8b379e5',
  slabv1: 'd05dd43c-0dd3-4bbd-bdbc-22734a256a60',
};

export const P1 = ID.P1;
export const P2 = ID.P2;
export const P3 = ID.P3;

const LABELS = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k.replace(/^P\d_/, '')]));
// The short label of an id (I1, L1, F2, discp10, P1); anything else is returned as is.
export const label = (id) => LABELS[id] ?? id;
export const providerLabel = label;
