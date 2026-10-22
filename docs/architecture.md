# System Architecture: Shenaly Rent a Car Operations Platform

## High-Level Architecture

The platform is designed to provide complete operational visibility over fleet utilization, renter verification, return condition checks, and vehicle-level profitability.

```
+------------------------------------------------------------------------+
|                      CLIENT-SIDE INTERFACES                            |
|                                                                        |
|  [Admin & Staff Web Portal (React + Tailwind CSS)]                     |
|  - Role-based views: Admin vs Staff                                    |
|  - Real-time fleet status, Net-Profit & ROI engine                     |
|  - Fleet Booking Calendar & Gantt timeline (early reservations)        |
|  - Manual early booking creation & deposit recording                   |
|  - Document verification viewer (NIC / DL / DMT temporary permits)    |
|  - Pickup / Drop 6-angle photo inspection comparison                   |
|  - WhatsApp weekly performance preview & trigger                       |
|                                                                        |
|  [Public Guest Front Link (Web Browser — No App Required)]             |
|  - Mobile & desktop self-registration for local & foreign renters      |
|  - Direct early vehicle reservation & date selection                   |
|  - Document photo attachments & digital voucher confirmation card      |
|  - One-click WhatsApp booking confirmation to Shenaly reservations     |
+-----------------------------------+------------------------------------+
                                    | HTTPS / REST APIs
                                    v
+------------------------------------------------------------------------+
|                        BACKEND API (Node.js / Express)                 |
|                                                                        |
|  [Authentication & RBAC]         [Rental & Ledger Engine]              |
|  - JWT token verification        - Days * Rate + Deposit balance       |
|  - Admin vs Staff permissions    - Multi-method payments (Cash/Slip)   |
|                                                                        |
|  [Profit Calculation Service]    [WhatsApp Integration Service]        |
|  - Revenue - Operational Costs   - Meta WhatsApp Business Cloud API    |
|  - Per-vehicle ROI tracking      - Scheduled Monday 8:00 AM digest     |
+-------------------+-------------------------------+--------------------+
                    |                               |
                    v                               v
+-----------------------------+   +--------------------------------------+
|     DATABASE (MongoDB)      |   |       AWS S3 OBJECT STORAGE          |
|                             |   |                                      |
| - Vehicles & Cost Entries   |   | - Renter Documents (NIC / IDP / DL)  |
| - Renters & Identity Data   |   | - Vehicle Inspection Photos          |
| - Active & Past Contracts   |   | - Uploaded Service Bills & Receipts  |
| - Payment Records           |   | - Pre-signed access control URLs     |
+-----------------------------+   +--------------------------------------+
```

## Security & Compliance
- **Identity Storage**: Renter identity documents (NIC, Passports, DMT Temporary Permits) are stored privately with pre-signed ephemeral URLs to prevent unauthorized access.
- **Audit Trails**: Rental inspection photos are timestamped upon upload and cannot be modified once a contract is closed.
- **Role Isolation**: Staff accounts cannot view sensitive business-wide net profit margins or delete logged service bills without Admin approval.
