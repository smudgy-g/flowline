-- UAT only: apply with psql to the isolated project after config.toml's seeds.
-- Cloud City is supplier@cloud-city.test; its seeded LKW offer is e000...0003.
-- Synthetic source IDs are reserved for this report fixture (no real inquiries).
BEGIN;

INSERT INTO public.company_billing_contracts
  (id, company_id, contract_type, invoice_issuer, amount_type, valid_from, valid_to, auto_billing_enabled)
VALUES
  ('aa000000-0000-4000-8000-000000000001',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
   'lead_gen', 'internal', 'lead_rates', '2026-01-01', '2099-01-01', false);

INSERT INTO public.company_lead_rates
  (id, company_id, contract_id, vehicle_category, price_per_lead, valid_from, valid_to, is_active)
VALUES
  ('aa000000-0000-4000-8000-000000000002',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
   'aa000000-0000-4000-8000-000000000001',
   'lkw', 25.00, '2026-01-01', '2099-01-01', true);

INSERT INTO public.company_lead_events
  (id, company_id, contract_id, source_type, source_id,
   vehicle_category, lead_domain, billable_amount_eur, created_at)
VALUES
  ('aa000000-0000-4000-8000-000000000003',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
   'aa000000-0000-4000-8000-000000000001',
   'web_form', 'aa000000-0000-4000-8000-000000000005',
   'lkw', 'renting', 25.00, '2026-09-10 12:00:00+00'),
  ('aa000000-0000-4000-8000-000000000004',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
   'aa000000-0000-4000-8000-000000000001',
   'web_form', 'aa000000-0000-4000-8000-000000000006',
   'lkw', 'renting', 25.00, '2026-09-11 12:00:00+00');

-- A second selling supplier (Mos Eisley) with its own sale offer and submitted
-- lead: the Sale tab journey proves neither supplier can see the other's leads.
UPDATE public.companies SET is_selling = true
  WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

INSERT INTO public.company_sale_offers
  ("id", "company_id", "vehicle_ref_id", "title", "is_published", "published_at",
   "condition", "first_registered_at", "current_mileage", "is_business_only", "availability",
   "fuel_type", "transmission", "power_ps", "co2_emissions_gkm", "energy_efficiency_class",
   "sale_price", "is_vat_deductible", "is_price_negotiable", "delivery_cost",
   "contact_person", "contact_email", "location", "has_nationwide_delivery")
VALUES
  ('f3000000-0000-4000-8000-000000000011',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
   'd0000000-0000-4000-8000-000000000001',
   'Mercedes-Benz Sprinter 316 Mos Eisley', true, now(), 'used', '2021-09-01', 91000, true,
   'immediate', 'diesel', 'manual', 163, 250, 'E', 25900, true, true, 0,
   'Wuher Cantina', 'wuher@mos-eisley.test', 'Hamburg', false);

INSERT INTO public.sale_offer_leads
  ("sale_offer_id", "offer_title", "is_financing_inquiry", "quoted_sale_price",
   "customer_first_name", "customer_last_name", "customer_email", "customer_phone",
   "is_business", "customer_company", "customer_city", "customer_zip",
   "status", "urgency", "submitted_at", "created_at")
VALUES
  ('f3000000-0000-4000-8000-000000000011', 'Mercedes-Benz Sprinter 316 Mos Eisley', false, 25900,
   'Greedo', 'Rodian', 'greedo@rodia.test', '+49 170 0000011', true, 'Rodian Haulage GmbH',
   'Hamburg', '20457', 'submitted', 'urgent',
   now() - interval '2 days', now() - interval '2 days');

COMMIT;
