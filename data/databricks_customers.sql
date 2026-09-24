-- Insert the 5 hackathon personas into the Databricks customers table.
-- Column list matches the verified schema of `databricks-hackathon`.`00data`.`customers` (20 cols).
-- Scores/features live in customer_features + customer_predictions (surfaced via the customer_360 view);
-- those inserts are generated separately once their column lists are confirmed.
-- Run in a Databricks SQL editor / warehouse (Genie is read-only, so this can't run via the genie MCP).

INSERT INTO `databricks-hackathon`.`00data`.`customers`
(customer_id, first_name, last_name, email, phone, date_of_birth, signup_date, segment, loyalty_tier,
 city, state_province, postal_code, country_code, preferred_channel, marketing_opt_in, account_status,
 synthetic_record, source_system, source_updated_at, ingested_at)
VALUES
('CUST-1001','Ava','Chen','hoc+ava@okahu.ai','+15550100101',DATE'1991-04-12',DATE'2022-03-14','VIP','Platinum',
 'Seattle','WA','98101','US','email',true,'active',true,'hackathon_personas',current_timestamp(),current_timestamp()),
('CUST-1002','Marcus','Bello','hoc+marcus@okahu.ai','+15550100102',DATE'1986-11-03',DATE'2021-09-02','High-Value','Gold',
 'Austin','TX','73301','US','email',true,'active',true,'hackathon_personas',current_timestamp(),current_timestamp()),
('CUST-1003','Priya','Nair','hoc+priya@okahu.ai','+15550100103',DATE'1998-07-25',DATE'2026-08-30','New','Silver',
 'Jersey City','NJ','07302','US','sms',true,'active',true,'hackathon_personas',current_timestamp(),current_timestamp()),
('CUST-1004','Diego','Santos','hoc+diego@okahu.ai','+15550100104',DATE'1994-01-30',DATE'2023-11-19','Bargain-Hunter','Bronze',
 'Miami','FL','33101','US','email',true,'active',true,'hackathon_personas',current_timestamp(),current_timestamp()),
('CUST-1005','Sophie','Laurent','hoc+sophie@okahu.ai','+15550100105',DATE'1989-09-18',DATE'2022-06-07','Lapsed','Silver',
 'Portland','OR','97201','US','email',true,'active',true,'hackathon_personas',current_timestamp(),current_timestamp());
