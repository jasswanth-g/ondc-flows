// Retailers already held by the mock Seller NP (shared by the server and the playground).
// `providers` maps provider id -> that retailer's terms with the provider. The same outlet code
// (customer_id) is returned by every provider serving the retailer.
export const RETAILERS = [
  {
    customer_id: 'CUST-2024-001234',
    shop_name: 'Sharma Kirana Store',
    phone: '9876543210',
    email: 'sharma.kirana@email.com',
    PAN: 'AABCU9603R',
    GSTIN: '29AABCU9603R1ZM',
    addressLine: 'Shop No. 12, Lakshmi Complex, MG Road',
    address: { name: 'Shop No. 12', building: 'Lakshmi Complex', locality: 'MG Road', city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560001' },
    gps: '12.9756,77.6066',
    providers: {
      P1: { credit_limit: '25000.00', poc: { name: 'Rajesh Kumar', phone: '9876500011', email: 'rajesh.kumar@abcdist.example' } },
      P2: { credit_limit: '10000.00', poc: { name: 'Anita Rao', phone: '9845012345', email: 'anita.rao@xyzdist.example' } },
    },
  },
  {
    customer_id: 'CUST-2024-003311',
    shop_name: 'Lakshmi General Stores',
    phone: '9845011122',
    email: 'lakshmi.stores@email.com',
    PAN: 'AAKPL1234C',
    GSTIN: '29AAKPL1234C1Z5',
    addressLine: 'No. 45, Sai Arcade, Whitefield Main Road',
    address: { name: 'No. 45', building: 'Sai Arcade', locality: 'Whitefield Main Road', city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560066' },
    gps: '12.9698,77.7499',
    providers: {
      P2: { credit_limit: '15000.00', poc: { name: 'Anita Rao', phone: '9845012345', email: 'anita.rao@xyzdist.example' } },
    },
  },
  {
    customer_id: 'CUST-2024-005678',
    shop_name: 'Fresh Mart',
    phone: '9900112233',
    email: 'freshmart@email.com',
    PAN: 'AAFCF4321D',
    GSTIN: '29AAFCF4321D1ZQ',
    addressLine: 'Shop 3, Ganesh Towers, 9th Main Road, Jayanagar',
    address: { name: 'Shop 3', building: 'Ganesh Towers', locality: '9th Main Road', city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560041' },
    gps: '12.9279,77.5831',
    providers: {
      P1: { credit_limit: '20000.00', poc: { name: 'Suresh Gowda', phone: '9876500022', email: 'suresh.gowda@abcdist.example' } },
    },
  },
];

// Not held by the Seller NP: used for the /search (New Retailer) onboarding journey.
export const NEW_RETAILER = {
  shop_name: 'Ravi Provision Store',
  phone: '9811122233',
  email: 'ravi.provisions@email.com',
  PAN: 'AAGPR7788M',
  GSTIN: '29AAGPR7788M1Z3',
  addressLine: '22, 1st Cross, Koramangala 5th Block',
  address: { name: 'No. 22', building: 'Sri Sai Nilaya', locality: 'Koramangala 5th Block', city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560095' },
  gps: '12.9352,77.6245',
};

// Walk-in retailer for P3, which identifies no retailers (no customer_id is ever issued).
export const WALK_IN_RETAILER = {
  shop_name: 'Nandini Cool Drinks',
  phone: '9900554433',
  email: 'nandini.cool@email.com',
  GSTIN: '29AAHPN3344Q1Z8',
  addressLine: '8, Tumkur Road, Yeshwanthpur',
  address: { name: 'No. 8', building: 'Corner Shop', locality: 'Tumkur Road, Yeshwanthpur', city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560022' },
  gps: '13.0285,77.5400',
};
