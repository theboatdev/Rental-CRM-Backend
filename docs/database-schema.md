# Database Schema & Entity Relationships

## Entities & Relationships

### 1. `User` (Staff & Admin)
- `_id`: ObjectId
- `name`: String
- `email`: String (Unique)
- `passwordHash`: String
- `role`: Enum ['ADMIN', 'STAFF']
- `phone`: String
- `active`: Boolean

### 2. `Vehicle` (Fleet Inventory)
- `_id`: ObjectId
- `plateNumber`: String (Unique, e.g. `WP CAH-4821`)
- `make`: String (`Suzuki`, `Toyota`, `Honda`)
- `model`: String (`Alto K10`, `Axio Hybrid`, `Vezel`)
- `year`: Number
- `transmission`: Enum ['Automatic', 'Manual']
- `fuelType`: Enum ['Petrol', 'Diesel', 'Hybrid', 'Electric']
- `dailyRate`: Number (LKR)
- `depositAmount`: Number (LKR default: 25,000)
- `mileage`: Number (KM)
- `status`: Enum ['Available', 'Rented', 'In Service / Maintenance', 'Reserved']
- `thumbnail`: String (URL)

### 3. `Renter` (Client Profiles)
- `_id`: ObjectId
- `profileId`: String (Unique, auto-generated e.g. `SR-0146`)
- `fullName`: String
- `phone`: String
- `email`: String
- `isTourist`: Boolean
- `country`: String
- `address`: String
- `documents`: Array of:
  - `docType`: Enum ['NIC', 'Sri Lanka Driving License', 'Passport', 'IDP', 'DMT Permit', 'Utility Bill', 'Other']
  - `docNumber`: String
  - `fileUrl`: String
  - `verified`: Boolean
- `source`: Enum ['Counter Registration', 'Self-Registered (Online)']
- `emergencyContact`: Object (`name`, `phone`, `relation`)

### 4. `Rental` (Booking & Inspection Records)
- `_id`: ObjectId
- `rentalCode`: String (Unique, e.g. `RNT-2026-0042` or `BK-2026-0043`)
- `renter`: ObjectId -> `Renter`
- `vehicle`: ObjectId -> `Vehicle`
- `startDate`: Date
- `endDate`: Date
- `actualReturnDate`: Date
- `dailyRate`: Number (LKR)
- `totalDays`: Number
- `totalRentalAmount`: Number (LKR)
- `depositAmount`: Number (LKR)
- `depositRefunded`: Boolean
- `startMileage`: Number
- `endMileage`: Number
- `pickupInspection`: Object (`front`, `rear`, `leftSide`, `rightSide`, `interior`, `odometer`, `timestamp`, `notes`)
- `dropInspection`: Object (`front`, `rear`, `leftSide`, `rightSide`, `interior`, `odometer`, `timestamp`, `notes`)
- `status`: Enum ['Reserved', 'Active', 'Completed', 'Cancelled', 'Overdue']
- `bookingSource`: Enum ['Manual Counter', 'Online Self-Registration']
- `paymentStatus`: Enum ['Unpaid', 'Partially Paid', 'Fully Paid']

### 5. `VehicleCost` (Operating Costs & Service Bills)
- `_id`: ObjectId
- `vehicle`: ObjectId -> `Vehicle`
- `category`: Enum ['Routine Maintenance', 'Mechanical Repair', 'Tire Replacement', 'Insurance', 'Revenue License', 'Fuel', 'Accident Repair', 'Other']
- `title`: String
- `amount`: Number (LKR)
- `serviceCenter`: String
- `invoiceNumber`: String
- `billFileUrl`: String
- `expenseDate`: Date
- `odometerReading`: Number

### 6. `Payment` (Ledger Entries)
- `_id`: ObjectId
- `rental`: ObjectId -> `Rental`
- `renter`: ObjectId -> `Renter`
- `amount`: Number (LKR)
- `paymentType`: Enum ['Rental Payment', 'Security Deposit', 'Damage Charge', 'Late Fee', 'Deposit Refund']
- `paymentMethod`: Enum ['Cash (LKR)', 'Bank Transfer', 'Credit/Debit Card Slip', 'Online']
- `receiptNumber`: String (Unique, e.g. `RCPT-2026-0091`)
- `transactionReference`: String
- `paymentDate`: Date
