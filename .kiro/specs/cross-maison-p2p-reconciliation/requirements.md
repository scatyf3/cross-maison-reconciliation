# Requirements Document

## Introduction

The Cross-Maison Procure-to-Pay (P2P) Reconciliation prototype is a static, browser-based web application that demonstrates a governed information layer for LVMH. The application lets each Maison (Louis Vuitton, Dior, Fendi) keep its own local ERP configuration — local supplier codes, account codes, cost centers, invoice timing, and currencies — while producing a single, comparable LVMH Group P2P reporting view.

The end-to-end process covers: ingesting Maison CSV extracts, normalizing records against a centrally governed mapping table, validating records (required fields, 3-way match, duplicate detection), routing failures to an exception queue, generating a client-side AI recommendation with supporting evidence for ambiguous records, allowing a single human finance reviewer to approve or reject mapping changes with a full audit trail, consolidating all Maison data, and producing a comparable LVMH Group P2P report view.

The application is implemented as a plain static web app (HTML, CSS, vanilla JavaScript) with no build step, no backend server, and no database. It must be hostable on GitHub Pages, and all data is persisted in the browser. The "AI agent" is a client-side rules/heuristic matcher (string similarity plus mapping history) that recommends mappings with human-readable evidence; a human finance owner must approve all changes to financial master data.

## Glossary

- **System**: The Cross-Maison P2P Reconciliation web application running entirely in the browser.
- **Maison**: One of the LVMH brand entities (Louis Vuitton, Dior, Fendi), each operating an independent local ERP configuration.
- **Maison_Extract**: A CSV file produced from a single Maison's ERP containing invoice/P2P records with that Maison's local codes and currency.
- **P2P_Record**: A single procure-to-pay record from a Maison extract, containing supplier code, account code, cost center, purchase order reference, receipt reference, invoice reference, quantity, price, and currency.
- **Ingestion_Module**: The System component that loads a Maison_Extract CSV, parses rows into P2P_Records, and assigns a processing identifier.
- **Mapping_Table**: The centrally governed, browser-persisted table that maps a Maison's local supplier codes and account codes to canonical LVMH Supplier IDs and LVMH Account Codes. Each entry records its approval status and provenance.
- **Mapping_Entry**: A single row in the Mapping_Table linking a (Maison, local supplier code, local account code) tuple to an (LVMH Supplier ID, LVMH Account Code).
- **Normalization_Module**: The System component that applies approved Mapping_Entries to translate a P2P_Record's local codes into canonical LVMH codes.
- **Validation_Module**: The System component that checks required fields, performs the 3-way match, and detects duplicates.
- **Three_Way_Match**: The validation that a purchase order reference, a receipt reference, and an invoice reference agree on price, currency, and quantity for a P2P_Record.
- **Exception_Queue**: The browser-persisted collection of P2P_Records that failed validation, are missing information, or have no approved mapping.
- **Recommendation_Agent**: The client-side rules/heuristic matcher that produces a suggested Mapping_Entry for an ambiguous P2P_Record, along with a confidence score and supporting evidence. It performs no network calls and cannot alter the Mapping_Table on its own.
- **Supporting_Evidence**: The human-readable explanation accompanying a recommendation, including matched terms, string-similarity results, and relevant Mapping_Table history.
- **Finance_Reviewer**: The single human role in the prototype who investigates exception records, reviews recommendations, and approves or rejects mapping changes.
- **Audit_Trail**: The browser-persisted, append-only log recording each Mapping_Table change with the actor identity, timestamp, before value, after value, and the record that prompted the change.
- **Consolidation_Module**: The System component that combines all normalized Maison P2P_Records into the single LVMH common data structure.
- **Group_Report**: The final LVMH Group P2P reporting view presenting consolidated data with canonical LVMH Supplier IDs, LVMH Account Codes, and a common currency.
- **CSV_Parser**: The component that reads CSV text into P2P_Records.
- **CSV_Serializer**: The component that writes P2P_Records or the Group_Report back into CSV text.
- **Browser_Store**: The browser-local persistence mechanism (for example localStorage) used to retain the Mapping_Table, Exception_Queue, consolidated data, and Audit_Trail across page reloads.

## Requirements

### Requirement 1: Host as a Static Browser Application

**User Story:** As a course reviewer, I want the application to run as a plain static web app, so that it can be deployed on GitHub Pages without any backend.

#### Acceptance Criteria

1. THE System SHALL run using only HTML, CSS, and vanilla JavaScript without a build step.
2. THE System SHALL operate without a backend server and without a server-side database.
3. THE System SHALL function when served as static files from GitHub Pages.
4. THE System SHALL perform all data processing within the browser.
5. IF a feature would require a network call to an external service, THEN THE System SHALL implement that feature with client-side logic instead.

### Requirement 2: Persist Data in the Browser

**User Story:** As a Finance_Reviewer, I want application data to persist between sessions, so that my mapping decisions and processed records are retained across page reloads.

#### Acceptance Criteria

1. THE System SHALL store the Mapping_Table in the Browser_Store.
2. THE System SHALL store the Exception_Queue in the Browser_Store.
3. THE System SHALL store the consolidated P2P data in the Browser_Store.
4. THE System SHALL store the Audit_Trail in the Browser_Store.
5. WHEN the application is reloaded, THE System SHALL restore the Mapping_Table, Exception_Queue, consolidated data, and Audit_Trail from the Browser_Store.
6. IF the Browser_Store contains no prior data on first load, THEN THE System SHALL initialize the Mapping_Table and sample Maison_Extracts from the seeded data set.

### Requirement 3: Provide Seeded Sample Maison Extracts

**User Story:** As a course reviewer, I want sample Maison data included, so that I can demonstrate the full process without supplying my own files.

#### Acceptance Criteria

1. THE System SHALL include a seeded Maison_Extract in CSV format for Louis Vuitton.
2. THE System SHALL include a seeded Maison_Extract in CSV format for Dior.
3. THE System SHALL include a seeded Maison_Extract in CSV format for Fendi.
4. THE System SHALL include seeded P2P_Records that use each Maison's local supplier codes, account codes, cost centers, and currency.
5. THE System SHALL include seeded P2P_Records that exercise the auto-normalized path, the ambiguous-mapping path, and the validation-failure path.

### Requirement 4: Parse Maison CSV Extracts

**User Story:** As a Finance_Reviewer, I want to load a Maison's CSV extract, so that its P2P records enter the reconciliation process.

#### Acceptance Criteria

1. WHEN a Finance_Reviewer selects a Maison_Extract to load, THE CSV_Parser SHALL parse the CSV text into P2P_Records and complete parsing of an extract of up to 100,000 rows within 60 seconds.
2. THE CSV_Parser SHALL read supplier code, account code, cost center, purchase order reference, receipt reference, invoice reference, quantity, price, and currency from each row, where quantity is an integer from 0 to 999,999,999, price is a decimal from 0.00 to 999,999,999.99 with up to 2 decimal places, and currency is a 3-letter ISO 4217 code.
3. WHEN the CSV_Parser parses a Maison_Extract, THE Ingestion_Module SHALL associate each resulting P2P_Record with the identifier of the originating Maison.
4. WHEN the Ingestion_Module processes a P2P_Record, THE Ingestion_Module SHALL assign a processing identifier that is unique across all P2P_Records within the current reconciliation run.
5. IF a CSV row is missing a column required by the extract format, THEN THE CSV_Parser SHALL record a parse error identifying the affected row number and the missing column name, exclude that row from the produced P2P_Records, and continue parsing the remaining rows.
6. IF a CSV row contains a value that violates the type or range defined in criterion 2, THEN THE CSV_Parser SHALL record a parse error identifying the affected row number, the offending column name, and the reason for rejection, exclude that row from the produced P2P_Records, and continue parsing the remaining rows.
7. THE CSV_Serializer SHALL write P2P_Records into CSV text using the common LVMH extract format, including all nine columns listed in criterion 2 in that defined column order.
8. FOR ALL P2P_Records parsed from a valid Maison_Extract, parsing the records, serializing them, and parsing the result again SHALL produce P2P_Records in which all nine field values and the associated Maison identifier are identical to those of the originally parsed records.

### Requirement 5: Maintain a Centrally Governed Mapping Table

**User Story:** As an LVMH governance owner, I want approved mappings stored centrally, so that no mapping lives in an individual's undocumented spreadsheet.

#### Acceptance Criteria

1. THE System SHALL store all approved Maison-to-LVMH mappings in the single Mapping_Table.
2. THE Mapping_Table SHALL map each (Maison, local supplier code, local account code) tuple to an LVMH Supplier ID and an LVMH Account Code.
3. THE Mapping_Table SHALL record an approval status for each Mapping_Entry.
4. WHEN a P2P_Record is normalized, THE Normalization_Module SHALL use only Mapping_Entries whose approval status is approved.
5. THE System SHALL present the Mapping_Table to the Finance_Reviewer as the authoritative source of approved mappings.

### Requirement 6: Normalize Records Using Approved Mappings

**User Story:** As a Finance_Reviewer, I want records with a known mapping normalized automatically, so that routine records require no manual effort.

#### Acceptance Criteria

1. WHEN a P2P_Record is ingested, THE Normalization_Module SHALL search the Mapping_Table for an approved Mapping_Entry matching the record's Maison and local codes.
2. WHERE an approved Mapping_Entry matches a P2P_Record, THE Normalization_Module SHALL assign the LVMH Supplier ID and LVMH Account Code from that Mapping_Entry to the P2P_Record.
3. IF no approved Mapping_Entry matches a P2P_Record, THEN THE System SHALL route the P2P_Record to the Exception_Queue.
4. WHEN a P2P_Record is normalized and passes validation, THE System SHALL include the P2P_Record in the consolidated data.

### Requirement 7: Validate Required Fields

**User Story:** As a Finance_Reviewer, I want records with missing information flagged, so that incomplete records do not enter the Group report.

#### Acceptance Criteria

1. WHEN a P2P_Record is validated, THE Validation_Module SHALL verify that supplier code, account code, purchase order reference, receipt reference, invoice reference, quantity, price, and currency are present.
2. IF a required field is absent from a P2P_Record, THEN THE System SHALL route the P2P_Record to the Exception_Queue with a reason indicating the missing field.
3. WHEN the Validation_Module records a validation failure, THE System SHALL retain the specific failure reason with the P2P_Record.

### Requirement 8: Perform the 3-Way Match

**User Story:** As a Finance_Reviewer, I want purchase orders, receipts, and invoices reconciled, so that only consistent records are consolidated.

#### Acceptance Criteria

1. WHEN a P2P_Record is validated, THE Validation_Module SHALL compare the purchase order reference, the receipt reference, and the invoice reference for agreement on price, currency, and quantity within 5 seconds of validation start.
2. IF the purchase order reference, the receipt reference, or the invoice reference is absent from the P2P_Record, THEN THE System SHALL route the P2P_Record to the Exception_Queue with a reason indicating a missing reference, and SHALL retain the P2P_Record data unchanged.
3. IF the absolute difference between any two of the purchase order price, the receipt price, and the invoice price is greater than 0.00 in the record currency, THEN THE System SHALL route the P2P_Record to the Exception_Queue with a reason indicating a price mismatch, and SHALL retain the P2P_Record data unchanged.
4. IF the currency values of the purchase order, the receipt, and the invoice are not all identical, THEN THE System SHALL route the P2P_Record to the Exception_Queue with a reason indicating a currency mismatch, and SHALL retain the P2P_Record data unchanged.
5. IF the quantity values of the purchase order, the receipt, and the invoice are not all equal, THEN THE System SHALL route the P2P_Record to the Exception_Queue with a reason indicating a quantity mismatch, and SHALL retain the P2P_Record data unchanged.
6. WHEN the purchase order price, receipt price, and invoice price are equal within 0.00, the currency values are all identical, and the quantity values are all equal, THE Validation_Module SHALL mark the 3-way match as passed for the P2P_Record.

### Requirement 9: Detect Duplicate Records

**User Story:** As a Finance_Reviewer, I want duplicate purchase orders detected, so that the same spend is not counted twice.

#### Acceptance Criteria

1. WHEN a P2P_Record is validated, THE Validation_Module SHALL check whether another P2P_Record shares the same purchase order reference within the same Maison.
2. IF two P2P_Records within the same Maison share the same purchase order reference, THEN THE System SHALL route the later P2P_Record to the Exception_Queue with a reason indicating a duplicate purchase order.
3. WHEN the Validation_Module detects a duplicate, THE System SHALL retain references to the conflicting P2P_Records with the exception entry.

### Requirement 10: Maintain an Exception Queue

**User Story:** As a Finance_Reviewer, I want all problematic records collected in one place, so that I can investigate and resolve them systematically.

#### Acceptance Criteria

1. THE Exception_Queue SHALL contain each P2P_Record that failed validation, is missing required information, or has no approved mapping.
2. THE System SHALL display, for each P2P_Record in the Exception_Queue, the originating Maison, the local codes, and the reason the record entered the queue.
3. WHILE a P2P_Record remains in the Exception_Queue, THE System SHALL exclude the P2P_Record from the consolidated data.
4. WHEN a P2P_Record is resolved, THE System SHALL remove the P2P_Record from the Exception_Queue.

### Requirement 11: Recommend Mappings with Supporting Evidence

**User Story:** As a Finance_Reviewer, I want the agent to suggest a likely mapping with evidence, so that I can make a faster, informed decision on ambiguous records.

#### Acceptance Criteria

1. WHEN a P2P_Record enters the Exception_Queue because no approved mapping exists, THE Recommendation_Agent SHALL produce a suggested Mapping_Entry for the P2P_Record within 5 seconds of the record entering the Exception_Queue.
2. THE Recommendation_Agent SHALL compute the suggested Mapping_Entry using a string-similarity score between the record's local codes and existing Mapping_Table entries, combined with Mapping_Table history, and SHALL select the candidate Mapping_Entry with the highest combined score as the suggestion.
3. THE Recommendation_Agent SHALL produce a confidence score for each suggested Mapping_Entry expressed as a value from 0.00 to 1.00 inclusive.
4. THE Recommendation_Agent SHALL present Supporting_Evidence for each suggested Mapping_Entry that includes the matched terms, the string-similarity score for each matched term, and the relevant Mapping_Table history entries used in the computation.
5. THE Recommendation_Agent SHALL produce the suggested Mapping_Entry using only client-side computation and SHALL NOT issue any network call during computation of the suggestion.
6. IF the Recommendation_Agent finds no candidate Mapping_Entry with a confidence score at or above the configured similarity threshold, THEN THE System SHALL present the P2P_Record for manual mapping without a suggested Mapping_Entry and SHALL display an indication that no suggestion met the threshold.
7. IF the Recommendation_Agent fails to complete computation of the suggested Mapping_Entry, THEN THE System SHALL present the P2P_Record for manual mapping, SHALL display an error indication that no suggestion could be produced, and SHALL retain the P2P_Record in the Exception_Queue.

### Requirement 12: Require Human Approval for Mapping Changes

**User Story:** As an LVMH governance owner, I want a human to approve every mapping change, so that the agent cannot alter financial master data on its own.

#### Acceptance Criteria

1. THE Recommendation_Agent SHALL present suggested Mapping_Entries to the Finance_Reviewer in a read-only state and SHALL NOT create, modify, or delete any record in the Mapping_Table.
2. WHEN a Finance_Reviewer approves a suggested or manually entered Mapping_Entry, THE System SHALL add the Mapping_Entry to the Mapping_Table with a status of "approved" and SHALL record the approving Finance_Reviewer identifier and an approval timestamp.
3. IF a Finance_Reviewer submits a Mapping_Entry approval and the Mapping_Entry fails validation or conflicts with an existing approved Mapping_Entry, THEN THE System SHALL reject the approval, SHALL leave the Mapping_Table unchanged, and SHALL return an error message indicating the specific validation or conflict reason.
4. WHEN a Finance_Reviewer rejects a P2P_Record's resolution, THE System SHALL keep the P2P_Record in the Exception_Queue with a status of "on hold for correction" and SHALL record the rejection reason provided by the Finance_Reviewer.
5. WHILE a suggested Mapping_Entry has a status other than "approved" and is awaiting a Finance_Reviewer decision, THE System SHALL exclude the suggested Mapping_Entry from the set of approved mappings used for normalization.
6. WHEN a Finance_Reviewer approves a new Mapping_Entry, THE System SHALL normalize every Exception_Queue P2P_Record whose attributes match the new Mapping_Entry within 60 seconds of the approval and SHALL remove each successfully normalized P2P_Record from the Exception_Queue.
7. IF normalization of a matching Exception_Queue P2P_Record fails after the approval of a new Mapping_Entry, THEN THE System SHALL retain that P2P_Record in the Exception_Queue with a status indicating normalization failed and SHALL record the failure reason.

### Requirement 13: Record an Audit Trail for Mapping Changes

**User Story:** As an LVMH governance owner, I want to know who changed a mapping and when, so that mapping governance is traceable.

#### Acceptance Criteria

1. WHEN a Mapping_Entry is added or changed, THE System SHALL append an entry to the Audit_Trail.
2. THE Audit_Trail entry SHALL record the acting Finance_Reviewer identity, the timestamp of the change, the prior mapping value, the new mapping value, and the P2P_Record that prompted the change.
3. THE Audit_Trail SHALL be append-only, so that existing Audit_Trail entries are retained when new entries are added.
4. THE System SHALL display the Audit_Trail to the Finance_Reviewer.

### Requirement 14: Consolidate Normalized Maison Data

**User Story:** As an LVMH reporting owner, I want all Maison data consolidated into one structure, so that the Group can report on comparable data.

#### Acceptance Criteria

1. WHEN P2P_Records from multiple Maisons are normalized and pass validation, THE Consolidation_Module SHALL combine the P2P_Records into the single LVMH common data structure.
2. THE Consolidation_Module SHALL represent each consolidated P2P_Record using the LVMH Supplier ID and the LVMH Account Code.
3. THE Consolidation_Module SHALL exclude P2P_Records that remain in the Exception_Queue from the consolidated data.
4. WHEN a previously excluded P2P_Record is resolved, THE Consolidation_Module SHALL include the P2P_Record in the consolidated data.

### Requirement 15: Produce the LVMH Group Report

**User Story:** As an LVMH reporting owner, I want a comparable Group P2P report view, so that I can review spend across Maisons on a common basis.

#### Acceptance Criteria

1. WHEN consolidated data is available, THE System SHALL present the Group_Report using LVMH Supplier IDs, LVMH Account Codes, and a common currency.
2. THE Group_Report SHALL present the mapping from each Maison local supplier code to its LVMH Supplier ID.
3. THE Group_Report SHALL present the count of P2P_Records that were auto-normalized, the count resolved through finance judgment, and the count still in the Exception_Queue.
4. WHEN a Finance_Reviewer requests an export, THE CSV_Serializer SHALL write the Group_Report to CSV text in the common LVMH format.

### Requirement 16: Preserve Maison Autonomy

**User Story:** As a Maison system owner, I want to keep my local ERP configuration, so that reconciliation does not force changes to my local codes.

#### Acceptance Criteria

1. THE System SHALL accept each Maison_Extract using that Maison's local supplier codes, account codes, cost centers, and currency.
2. THE System SHALL perform all translation to LVMH codes within the Normalization_Module without modifying the source Maison_Extract.
3. THE System SHALL retain each P2P_Record's original Maison local codes alongside its assigned LVMH codes.

### Requirement 17: Provide a Single-Reviewer Interface

**User Story:** As a Finance_Reviewer, I want a simple, clean interface, so that I can move through the reconciliation process without friction.

#### Acceptance Criteria

1. THE System SHALL operate with a single Finance_Reviewer role for the prototype.
2. THE System SHALL provide a view for loading Maison_Extracts, a view for the Exception_Queue, a view for the Mapping_Table, a view for the Audit_Trail, and a view for the Group_Report.
3. WHEN a Finance_Reviewer resolves an Exception_Queue record, THE System SHALL update the Exception_Queue view, the Mapping_Table view, and the Group_Report view to reflect the resolution.
