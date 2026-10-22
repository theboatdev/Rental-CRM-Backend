/**
 * Demo Data Seeder for Shenaly Rent a Car
 * Populates realistic vehicles, renters, active rentals, and operational costs.
 */

const sampleVehicles = [
  {
    plateNumber: 'WP CAH-4821',
    make: 'Suzuki',
    model: 'Alto K10',
    year: 2023,
    transmission: 'Automatic',
    fuelType: 'Petrol',
    dailyRate: 6500,
    depositAmount: 25000,
    mileage: 38400,
    status: 'Rented',
    thumbnail: 'https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?auto=format&fit=crop&w=600&q=80',
    notes: 'Economical city car. Very high demand.'
  },
  {
    plateNumber: 'WP KX-9312',
    make: 'Toyota',
    model: 'Axio Hybrid',
    year: 2021,
    transmission: 'Automatic',
    fuelType: 'Hybrid',
    dailyRate: 14000,
    depositAmount: 35000,
    mileage: 62100,
    status: 'Available',
    thumbnail: 'https://images.unsplash.com/photo-1590362891988-39e15974fa61?auto=format&fit=crop&w=600&q=80',
    notes: 'Premium sedan, ideal for tourist round-trips.'
  },
  {
    plateNumber: 'WP PE-1284',
    make: 'Honda',
    model: 'Vezel RS',
    year: 2022,
    transmission: 'Automatic',
    fuelType: 'Hybrid',
    dailyRate: 18500,
    depositAmount: 40000,
    mileage: 49300,
    status: 'Rented',
    thumbnail: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=600&q=80',
    notes: 'Compact SUV. Popular for Kandy and Nuwara Eliya tours.'
  },
  {
    plateNumber: 'WP ND-5509',
    make: 'Toyota',
    model: 'HiAce KDH Super GL',
    year: 2020,
    transmission: 'Automatic',
    fuelType: 'Diesel',
    dailyRate: 24000,
    depositAmount: 50000,
    mileage: 91500,
    status: 'In Service / Maintenance',
    thumbnail: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=600&q=80',
    notes: 'Tourist passenger van. Scheduled 90,000km injector service.'
  }
];

const sampleRenters = [
  {
    profileId: 'SR-0146',
    fullName: 'Nimal Perera',
    phone: '+94 77 123 4567',
    email: 'nimal.p@gmail.com',
    isTourist: false,
    country: 'Sri Lanka',
    address: 'No. 45, Galle Road, Colombo 03',
    documents: [
      { docType: 'National Identity Card (NIC)', docNumber: '198812304561', fileUrl: '#', verified: true },
      { docType: 'Sri Lanka Driving License', docNumber: 'B3920194', fileUrl: '#', verified: true }
    ]
  },
  {
    profileId: 'SR-0147',
    fullName: 'David Miller',
    phone: '+44 7911 123456',
    email: 'david.miller@uktravel.co.uk',
    isTourist: true,
    country: 'United Kingdom',
    address: 'Cinnamon Grand Hotel, Colombo',
    documents: [
      { docType: 'Passport (Foreign Tourist)', docNumber: 'GB9821034', fileUrl: '#', verified: true },
      { docType: 'International Driving Permit (AA Ceylon recognized)', docNumber: 'IDP-UK-984', fileUrl: '#', verified: true },
      { docType: 'DMT Airport Temporary Driving Permit', docNumber: 'DMT-BIA-2026-491', fileUrl: '#', verified: true }
    ]
  },
  {
    profileId: 'SR-0148',
    fullName: 'Kavindi Wickramasinghe',
    phone: '+94 71 889 9234',
    email: 'kavindi.w@dialog.lk',
    isTourist: false,
    country: 'Sri Lanka',
    address: '12/4 Temple Road, Nugegoda',
    documents: [
      { docType: 'National Identity Card (NIC)', docNumber: '199578102391', fileUrl: '#', verified: true },
      { docType: 'Sri Lanka Driving License', docNumber: 'B4829103', fileUrl: '#', verified: true }
    ]
  }
];

console.log('Seed data template ready for MongoDB or In-Memory Demo Store.');
module.exports = { sampleVehicles, sampleRenters };
