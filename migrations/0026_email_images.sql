-- v3.19: images in mail. An embedded image (cid:) is shown from its stored
-- attachment, so attachments keep their Content-ID. Mail stored before keeps
-- html_version 1 and is rebuilt once from its raw message when opened, which
-- restores remote image addresses (shown through the image proxy) and fills
-- in the Content-IDs.
ALTER TABLE attachments ADD COLUMN content_id TEXT;
ALTER TABLE messages ADD COLUMN html_version INTEGER NOT NULL DEFAULT 1;
