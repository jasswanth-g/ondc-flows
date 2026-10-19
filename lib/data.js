// Retailers already held by the Seller NP live in public/shared so the playground can use them.
import { RETAILERS } from '../public/shared/retailers.js';

export { RETAILERS };

// Seed data for the mock Seller NP: three providers.
// The catalogue publishes no retailer_info_required, so every provider's catalogue is shown to every
// retailer and P2P is not required before ordering. `retailer_info_required` below is used only to
// answer a P2P /search if a buyer NP sends one (it is never sent in on_search).

export const SELLER = {
  name: 'DigiDukaan Mock Seller NP',
  short_desc: 'B2B Wholesale Distribution Platform (mock)',
  long_desc: 'Mock eB2B Seller NP for buyer-app integration testing',
  np_type: 'MSN',
  gst: '29AAACD1234M1Z9',
};

// Variant groups (custom categories). attrs are the variant axes in display order.
const VARIANT_GROUPS = {
  V1: { name: 'Aashirvaad Atta Variant Group', attrs: ['item.quantity.unitized.measure'] },
  V2: { name: 'B Natural Juice Variant Group', attrs: ['item.quantity.unitized.measure', 'item.quantity.unitized.count'] },
  V3: { name: 'Surf Excel Variant Group', attrs: ['item.quantity.unitized.measure'] },
  V4: { name: 'Frooti Variant Group', attrs: ['item.quantity.unitized.measure', 'item.quantity.unitized.count'] },
  V5: { name: 'Appy Fizz Variant Group', attrs: ['item.quantity.unitized.measure'] },
};

// Serviceability published for every location: pan-India (type 12, the whole country).
const PAN_INDIA = { type: '12', unit: 'country', val: 'IND' };

const RETAILER_INFO_NEW = {
  type: 'new',
  codes: { phone_number: 'true', GSTIN: 'false', PAN: 'false', shop_name: 'true', email: 'false', address: 'true' },
};
const RETAILER_INFO_EXISTING_ID = { type: 'existing', codes: { customer_id: 'true' } };
const RETAILER_INFO_EXISTING_PHONE_PAN = { type: 'existing', codes: { phone_number: 'true', GSTIN: 'false', PAN: 'true' } };

const ITC_STATUTORY = {
  manufacturer_or_packer_name: 'ITC Limited',
  manufacturer_or_packer_address: 'ITC Quality Care Cell, P.O Box No.592, Bangalore-560005',
};
const HUL_STATUTORY = {
  manufacturer_or_packer_name: 'Hindustan Unilever Limited',
  manufacturer_or_packer_address: 'Unilever House, B D Sawant Marg, Chakala, Andheri East, Mumbai-400099',
};
const PARLE_STATUTORY = {
  manufacturer_or_packer_name: 'Parle Agro Pvt Ltd',
  manufacturer_or_packer_address: 'Parle Agro, Western Express Highway, Andheri East, Mumbai-400099',
};

export const PROVIDERS = [
  {
    id: 'P1',
    manufacturer: 'ITC Limited',
    code: 'distributor',
    distributor: 'ABC Distributors',
    long_desc: 'FMCG distributor for ITC brands in South Bengaluru',
    gstin: '29AABCA1234F1Z5',
    pan: 'AABCA1234F',
    phone: '9886098860',
    email: 'orders@abcdist.example',
    care: 'ABC Support,support@abcdist.example,18004254444',
    settlement: { beneficiary_name: 'ABC Distributors', upi_address: 'abcdist@oksbi', bank_name: 'State Bank of India', branch_name: 'Jayanagar Branch' },
    fulfillments: [
      { id: 'F1', category: 'Standard Delivery', tat: 'P2D' },
      { id: 'F2', category: 'Immediate Delivery', tat: 'P1D' },
    ],
    min_order_value: 500,
    retailer_info_required: [RETAILER_INFO_NEW, RETAILER_INFO_EXISTING_ID, RETAILER_INFO_EXISTING_PHONE_PAN],
    brand_images: ['Aashirvaad', 'B Natural', 'Sunfeast', 'Bingo', 'Yippee'],
    locations: [
      {
        id: 'L1', name: 'ABC Distributors Warehouse - Jayanagar', gps: '12.9250,77.5938',
        address: { locality: 'Jayanagar', street: 'Jayanagar 4th Block', city: 'Bengaluru', area_code: '560041', state: 'KA' },
        serviceability: PAN_INDIA,
      },
      {
        id: 'L2', name: 'ABC Distributors Warehouse - BTM Layout', gps: '12.9166,77.6101',
        address: { locality: 'BTM Layout', street: 'BTM Layout 2nd Stage', city: 'Bengaluru', area_code: '560076', state: 'KA' },
        serviceability: PAN_INDIA,
      },
    ],
    items: [
      { id: 'I1', group: 'V1', name: 'Aashirvaad Whole Wheat Atta 1kg', ean: '8901725121112', count: '1', unit: 'kilogram', value: '1', price: '52.00', mrp: '55.00', min: '20', max: '100', location: 'L1', category: 'Atta, Flours and Sooji', brand: 'Aashirvaad', commodity: 'Wheat Flour (Atta)', nutrition: 'Energy(KCal)-(per 100g) 348; Protein(g)-(per 100g) 11.8', pack: { set: '10', case: '40', selling_unit: ['10', '20'] } },
      { id: 'I2', group: 'V1', name: 'Aashirvaad Whole Wheat Atta 5kg', ean: '8901725121129', count: '1', unit: 'kilogram', value: '5', price: '245.00', mrp: '260.00', min: '10', max: '50', location: 'L1', category: 'Atta, Flours and Sooji', brand: 'Aashirvaad', commodity: 'Wheat Flour (Atta)', nutrition: 'Energy(KCal)-(per 100g) 348; Protein(g)-(per 100g) 11.8' },
      { id: 'I3', group: 'V1', name: 'Aashirvaad Whole Wheat Atta 10kg', ean: '8901725121136', count: '1', unit: 'kilogram', value: '10', price: '470.00', mrp: '499.00', min: '5', max: '30', location: 'L2', category: 'Atta, Flours and Sooji', brand: 'Aashirvaad', commodity: 'Wheat Flour (Atta)', nutrition: 'Energy(KCal)-(per 100g) 348; Protein(g)-(per 100g) 11.8' },
      { id: 'I4', group: 'V2', name: 'B Natural Mixed Fruit 200ml (Case of 24)', ean: '8901725300012', count: '24', unit: 'millilitre', value: '200', price: '480.00', mrp: '540.00', min: '5', max: '20', location: 'L1', category: 'Fruit Juices and Fruit Drinks', brand: 'B Natural', commodity: 'Mixed Fruit Juice', nutrition: 'Energy(KCal)-(per 100ml) 54; Sugars(g)-(per 100ml) 12.5' },
      { id: 'I5', group: 'V2', name: 'B Natural Mixed Fruit 1L (Pack of 6)', ean: '8901725300029', count: '6', unit: 'litre', value: '1', price: '690.00', mrp: '750.00', min: '3', max: '15', location: 'L2', category: 'Fruit Juices and Fruit Drinks', brand: 'B Natural', commodity: 'Mixed Fruit Juice', nutrition: 'Energy(KCal)-(per 100ml) 54; Sugars(g)-(per 100ml) 12.5' },
      { id: 'I6', name: 'Sunfeast Dark Fantasy Choco Fills 75g (Box of 12)', ean: '8901725133405', count: '12', unit: 'gram', value: '75', price: '360.00', mrp: '400.00', min: '5', max: '50', location: 'L1', category: 'Chocolates and Biscuits', brand: 'Sunfeast', commodity: 'Cookies', nutrition: 'Energy(KCal)-(per 100g) 502; Sugars(g)-(per 100g) 38.0' },
      { id: 'I7', name: 'Bingo Mad Angles Achaari Masti 66g (Pack of 20)', ean: '8901725014505', count: '20', unit: 'gram', value: '66', price: '380.00', mrp: '400.00', min: '5', max: '40', location: 'L1', category: 'Snacks and Namkeen', brand: 'Bingo', commodity: 'Potato Chips', nutrition: 'Energy(KCal)-(per 100g) 536; Fat(g)-(per 100g) 30.1' },
      { id: 'I8', name: 'Yippee Magic Masala Noodles 280g (Case of 24)', ean: '8901725181208', count: '24', unit: 'gram', value: '280', price: '1100.00', mrp: '1200.00', min: '2', max: '20', location: 'L2', category: 'Pasta, Soup and Noodles', brand: 'Yippee', commodity: 'Instant Noodles', nutrition: 'Energy(KCal)-(per 100g) 445; Protein(g)-(per 100g) 9.2' },
    ],
    statutory: ITC_STATUTORY,
    fssai: '10012011000011',
  },
  {
    id: 'P2',
    manufacturer: 'Hindustan Unilever Limited',
    code: 'distributor',
    distributor: 'XYZ Distributors',
    long_desc: 'HUL super-stockist for East Bengaluru',
    gstin: '29AAECX5678K1Z2',
    pan: 'AAECX5678K',
    phone: '9845098450',
    email: 'orders@xyzdist.example',
    care: 'XYZ Support,support@xyzdist.example,18001021234',
    settlement: { beneficiary_name: 'XYZ Distributors', upi_address: 'xyzdist@okhdfcbank', bank_name: 'HDFC Bank', branch_name: 'Whitefield Branch' },
    fulfillments: [{ id: 'F1', category: 'Standard Delivery', tat: 'P2D' }],
    min_order_value: 2000,
    retailer_info_required: [RETAILER_INFO_EXISTING_ID, RETAILER_INFO_EXISTING_PHONE_PAN],
    brand_images: ['Surf Excel', 'Vim', 'Brooke Bond', 'Bru', 'Kissan', 'Knorr'],
    locations: [
      {
        id: 'L3', name: 'XYZ Distributors Depot - Whitefield', gps: '12.9698,77.7500',
        address: { locality: 'Whitefield', street: 'ITPL Main Road', city: 'Bengaluru', area_code: '560066', state: 'KA' },
        serviceability: PAN_INDIA,
      },
    ],
    items: [
      { id: 'I9', group: 'V3', name: 'Surf Excel Easy Wash Detergent Powder 1kg', ean: '8901030703119', count: '1', unit: 'kilogram', value: '1', price: '130.00', mrp: '140.00', min: '10', max: '200', location: 'L3', category: 'Cleaning & Household', brand: 'Surf Excel', commodity: 'Detergent Powder' },
      { id: 'I10', group: 'V3', name: 'Surf Excel Easy Wash Detergent Powder 4kg', ean: '8901030703126', count: '1', unit: 'kilogram', value: '4', price: '495.00', mrp: '540.00', min: '5', max: '50', location: 'L3', category: 'Cleaning & Household', brand: 'Surf Excel', commodity: 'Detergent Powder' },
      { id: 'I11', name: 'Vim Dishwash Bar 300g (Pack of 3)', ean: '8901030865237', count: '3', unit: 'gram', value: '300', price: '85.00', mrp: '90.00', min: '20', max: '200', location: 'L3', category: 'Cleaning & Household', brand: 'Vim', commodity: 'Dishwash Bar' },
      { id: 'I12', name: 'Brooke Bond Red Label Tea 500g', ean: '8901030571138', count: '1', unit: 'gram', value: '500', price: '260.00', mrp: '285.00', min: '10', max: '100', location: 'L3', category: 'Tea and Coffee', brand: 'Brooke Bond', commodity: 'Tea', nutrition: 'Energy(KCal)-(per 100g) 0' },
      { id: 'I13', name: 'Bru Instant Coffee 100g', ean: '8901030602238', count: '1', unit: 'gram', value: '100', price: '290.00', mrp: '320.00', min: '10', max: '100', location: 'L3', category: 'Tea and Coffee', brand: 'Bru', commodity: 'Instant Coffee', nutrition: 'Energy(KCal)-(per 100g) 315' },
      { id: 'I14', name: 'Kissan Fresh Tomato Ketchup 950g', ean: '8901030614286', count: '1', unit: 'gram', value: '950', price: '135.00', mrp: '150.00', min: '12', max: '120', location: 'L3', category: 'Sauces, Spreads and Dips', brand: 'Kissan', commodity: 'Tomato Ketchup', nutrition: 'Energy(KCal)-(per 100g) 116; Sugars(g)-(per 100g) 26.0' },
      { id: 'I15', name: 'Knorr Classic Thick Tomato Soup 53g (Pack of 10)', ean: '8901030689376', count: '10', unit: 'gram', value: '53', price: '520.00', mrp: '550.00', min: '2', max: '30', location: 'L3', category: 'Pasta, Soup and Noodles', brand: 'Knorr', commodity: 'Instant Soup Mix', nutrition: 'Energy(KCal)-(per 100g) 380' },
    ],
    statutory: HUL_STATUTORY,
    fssai: '10013022000456',
  },
  {
    id: 'P3',
    manufacturer: 'Parle Agro Pvt Ltd',
    code: 'wholesaler',
    distributor: 'Ganesh Wholesale Mart',
    long_desc: 'Beverages wholesaler in North Bengaluru, open to all retailers',
    gstin: '29AAFCG9012P1Z7',
    pan: 'AAFCG9012P',
    phone: '9739097390',
    email: 'orders@ganeshwholesale.example',
    care: 'Ganesh Support,support@ganeshwholesale.example,18004190099',
    settlement: { beneficiary_name: 'Ganesh Wholesale Mart', upi_address: 'ganeshwm@okicici', bank_name: 'ICICI Bank', branch_name: 'Peenya Branch' },
    fulfillments: [{ id: 'F1', category: 'Standard Delivery', tat: 'P1D' }],
    min_order_value: 1500,
    retailer_info_required: [],
    brand_images: ['Frooti', 'Appy Fizz', 'Bailley'],
    locations: [
      {
        id: 'L4', name: 'Ganesh Wholesale Mart - Peenya', gps: '13.0285,77.5197',
        address: { locality: 'Peenya', street: 'Peenya Industrial Area Phase 2', city: 'Bengaluru', area_code: '560058', state: 'KA' },
        serviceability: PAN_INDIA,
      },
    ],
    items: [
      { id: 'I16', group: 'V4', name: 'Frooti Mango Drink 200ml (Case of 30)', ean: '8904063200019', count: '30', unit: 'millilitre', value: '200', price: '300.00', mrp: '330.00', min: '5', max: '50', location: 'L4', category: 'Fruit Juices and Fruit Drinks', brand: 'Frooti', commodity: 'Mango Drink', nutrition: 'Energy(KCal)-(per 100ml) 64; Sugars(g)-(per 100ml) 15.6' },
      { id: 'I17', group: 'V4', name: 'Frooti Mango Drink 1.2L (Pack of 12)', ean: '8904063200026', count: '12', unit: 'litre', value: '1.2', price: '780.00', mrp: '840.00', min: '2', max: '25', location: 'L4', category: 'Fruit Juices and Fruit Drinks', brand: 'Frooti', commodity: 'Mango Drink', nutrition: 'Energy(KCal)-(per 100ml) 64; Sugars(g)-(per 100ml) 15.6' },
      { id: 'I18', group: 'V5', name: 'Appy Fizz 250ml (Case of 24)', ean: '8904063210018', count: '24', unit: 'millilitre', value: '250', price: '480.00', mrp: '528.00', min: '5', max: '40', location: 'L4', category: 'Energy and Soft Drinks', brand: 'Appy Fizz', commodity: 'Carbonated Apple Drink', nutrition: 'Energy(KCal)-(per 100ml) 52; Sugars(g)-(per 100ml) 12.9' },
      { id: 'I19', group: 'V5', name: 'Appy Fizz 600ml (Case of 24)', ean: '8904063210025', count: '24', unit: 'millilitre', value: '600', price: '840.00', mrp: '912.00', min: '3', max: '30', location: 'L4', category: 'Energy and Soft Drinks', brand: 'Appy Fizz', commodity: 'Carbonated Apple Drink', nutrition: 'Energy(KCal)-(per 100ml) 52; Sugars(g)-(per 100ml) 12.9' },
      { id: 'I20', name: 'Bailley Packaged Drinking Water 1L (Case of 12)', ean: '8904063220017', count: '12', unit: 'litre', value: '1', price: '180.00', mrp: '240.00', min: '10', max: '100', location: 'L4', category: 'Water', brand: 'Bailley', commodity: 'Packaged Drinking Water', nutrition: 'Energy(KCal)-(per 100ml) 0' },
    ],
    statutory: PARLE_STATUTORY,
    fssai: '10014033000789',
  },
];

export { VARIANT_GROUPS };

// Terms given to a retailer the mock "creates" through /search (New Retailer).
export const NEW_RETAILER_TERMS = { credit_limit: '15000.00' };

export const findProvider = (id) => PROVIDERS.find((p) => p.id === id);
export const findItem = (provider, id) => provider?.items.find((i) => i.id === id);
export const findLocation = (provider, id) => provider?.locations.find((l) => l.id === id);
