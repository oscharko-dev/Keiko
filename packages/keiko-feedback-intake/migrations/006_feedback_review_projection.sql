ALTER TABLE feedback_payloads
  ADD COLUMN report_category text,
  ADD COLUMN report_feature_area text,
  ADD COLUMN report_impact text,
  ADD COLUMN report_errors integer,
  ADD COLUMN report_warnings integer,
  ADD COLUMN report_infos integer;

CREATE FUNCTION parse_feedback_payload_report_projection(bytes bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN convert_from(bytes, 'UTF8')::jsonb;
EXCEPTION
  WHEN invalid_text_representation OR character_not_in_repertoire OR numeric_value_out_of_range
  THEN RETURN NULL;
END;
$$;

WITH projections AS (
  SELECT id, parse_feedback_payload_report_projection(canonical_bytes) AS report
  FROM feedback_payloads
)
UPDATE feedback_payloads AS payload SET
  report_category = projection.report #>> '{diagnostics,category}',
  report_feature_area = projection.report #>> '{diagnostics,featureArea}',
  report_impact = projection.report ->> 'impact',
  report_errors = (projection.report #>> '{diagnostics,severityCounts,errors}')::integer,
  report_warnings = (projection.report #>> '{diagnostics,severityCounts,warnings}')::integer,
  report_infos = (projection.report #>> '{diagnostics,severityCounts,infos}')::integer
FROM projections AS projection WHERE projection.id = payload.id;

ALTER TABLE feedback_payloads
  ADD CONSTRAINT feedback_payload_report_category_valid CHECK (
    report_category IN ('defect', 'performance', 'usability', 'compatibility', 'other')
  ),
  ADD CONSTRAINT feedback_payload_report_feature_area_valid CHECK (
    report_feature_area IN (
      'installation', 'model-configuration', 'conversation', 'files', 'editor', 'terminal',
      'browser', 'local-knowledge', 'memory', 'git-delivery', 'updates', 'voice', 'other'
    )
  ),
  ADD CONSTRAINT feedback_payload_report_impact_valid CHECK (
    report_impact IN (
      'Blocks installation or startup', 'Blocks model or credential setup',
      'Blocks core workflow', 'Degrades core workflow', 'Visual or usability issue', 'Unknown'
    )
  ),
  ADD CONSTRAINT feedback_payload_report_severity_valid CHECK (
    (report_errors IS NULL AND report_warnings IS NULL AND report_infos IS NULL)
    OR (report_errors >= 0 AND report_warnings >= 0 AND report_infos >= 0)
  ),
  ADD CONSTRAINT feedback_payload_report_projection_complete CHECK (
    (
      report_category IS NULL AND report_feature_area IS NULL AND report_impact IS NULL
      AND report_errors IS NULL AND report_warnings IS NULL AND report_infos IS NULL
    ) OR (
      report_category IS NOT NULL AND report_feature_area IS NOT NULL AND report_impact IS NOT NULL
      AND (
        (report_errors IS NULL AND report_warnings IS NULL AND report_infos IS NULL)
        OR (report_errors IS NOT NULL AND report_warnings IS NOT NULL AND report_infos IS NOT NULL)
      )
    )
  );

CREATE FUNCTION populate_feedback_payload_report_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE report jsonb;
BEGIN
  report := parse_feedback_payload_report_projection(NEW.canonical_bytes);
  NEW.report_category := report #>> '{diagnostics,category}';
  NEW.report_feature_area := report #>> '{diagnostics,featureArea}';
  NEW.report_impact := report ->> 'impact';
  NEW.report_errors := (report #>> '{diagnostics,severityCounts,errors}')::integer;
  NEW.report_warnings := (report #>> '{diagnostics,severityCounts,warnings}')::integer;
  NEW.report_infos := (report #>> '{diagnostics,severityCounts,infos}')::integer;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_payload_report_projection
BEFORE INSERT ON feedback_payloads
FOR EACH ROW EXECUTE FUNCTION populate_feedback_payload_report_projection();

CREATE OR REPLACE FUNCTION prevent_feedback_payload_content_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.semantic_group_id <> OLD.semantic_group_id
     OR NEW.exact_body_sha256 <> OLD.exact_body_sha256
     OR NEW.canonical_bytes <> OLD.canonical_bytes
     OR NEW.created_at <> OLD.created_at
     OR NEW.report_category IS DISTINCT FROM OLD.report_category
     OR NEW.report_feature_area IS DISTINCT FROM OLD.report_feature_area
     OR NEW.report_impact IS DISTINCT FROM OLD.report_impact
     OR NEW.report_errors IS DISTINCT FROM OLD.report_errors
     OR NEW.report_warnings IS DISTINCT FROM OLD.report_warnings
     OR NEW.report_infos IS DISTINCT FROM OLD.report_infos THEN
    RAISE EXCEPTION 'feedback payload content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (6, now());
