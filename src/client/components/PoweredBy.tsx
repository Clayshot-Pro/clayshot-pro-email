import "../customization.css";

/**
 * Attribution required by the LTM Email Service licence. Deliberately takes no
 * input and reads no branding or appearance state, so no setting can hide or
 * change it.
 */
export function PoweredBy() {
  return (
    <p className="powered-by">
      Powered by{" "}
      <a href="https://github.com/LiamTheMo/LTM-Email-Service" target="_blank" rel="noopener noreferrer">
        LTM Email Service
      </a>
    </p>
  );
}
