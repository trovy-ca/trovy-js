import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from "react";
import {
  isTrovyConfigError,
  sanitiseTheme,
  type MountOptions,
  type SuccessPayload,
  type Theme,
  type WidgetError,
  type WidgetHandle,
  type WidgetState,
} from "../widget/core.js";
import type { LinkedCustomer } from "../link-protocol.js";

interface CommonProps {
  /** `trv_pk_live_…` or `trv_pk_test_…`. Never a secret key. */
  publishableKey: string;
  theme?: Theme;
  /** The form's accessible name. Translate it if your page is not in English. */
  title?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  onError?: (error: WidgetError) => void;
  onStateChange?: (state: WidgetState) => void;
  /** Shown instead of the form when it cannot load. Nothing, by default. */
  unavailableFallback?: ReactNode;
}

/** What `renderLinkFailed` is given. */
export interface LinkFailedView {
  error: WidgetError;
  /** Send the same token again. For `recovery` of `retry` or `sign-in`. */
  retry: () => void;
  /** Start the form over. For `recovery` of `verify-again`. */
  reset: () => void;
}

/** The component links the customer through your own route (`createLinkHandler`). */
export interface TrovySignupLinkProps extends CommonProps {
  /** A path on your own origin, such as `/api/trovy/link`. */
  linkUrl: string;
  /** The customer is linked and saved. Never carries the customer id: that stays on your server. */
  onLinked?: (customer: LinkedCustomer) => void;
  /** Replace the notice shown when linking fails. */
  renderLinkFailed?: (view: LinkFailedView) => ReactNode;
  onSuccess?: never;
}

/** You exchange the token yourself. */
export interface TrovySignupTokenProps extends CommonProps {
  /** Post `linkToken` to your server, which calls `customers.link` with the secret key. */
  onSuccess: (payload: SuccessPayload) => void;
  linkUrl?: never;
  onLinked?: never;
  renderLinkFailed?: never;
}

/** Exactly one of `linkUrl` or `onSuccess`. */
export type TrovySignupProps = TrovySignupLinkProps | TrovySignupTokenProps;

export interface TrovySignupHandle {
  /** Start the form over. */
  reset: () => void;
  /** Send the same token to `linkUrl` again. False when there is nothing that can be retried. */
  retry: () => boolean;
}

type Mount = (target: Element, options: MountOptions) => WidgetHandle;

interface View {
  state: WidgetState;
  linkError?: WidgetError;
  configError?: string;
}

const LOADING: View = { state: "loading" };

// One line per distinct mistake, however many times Strict Mode or a re-render
// runs the effect that finds it.
const logged = new Set<string>();

const NOTICE: Record<NonNullable<WidgetError["recovery"]>, { text: string; action?: string }> = {
  retry: { text: "We could not connect your rewards to your account.", action: "Try again" },
  "sign-in": { text: "Sign in to connect your rewards to your account.", action: "Try again" },
  "verify-again": {
    text: "We could not connect your rewards to your account. Please verify your number again.",
    action: "Start again",
  },
  developer: { text: "Rewards cannot be connected right now." },
};

/**
 * Build the component around a `mount`. `@trovy/sdk/react` binds it to Trovy's
 * production form; Trovy's own pre-production builds bind it elsewhere. Not
 * covered by semver: use `TrovySignup`.
 */
export function createTrovySignup(
  mount: Mount,
): ForwardRefExoticComponent<TrovySignupProps & RefAttributes<TrovySignupHandle>> {
  const TrovySignup = forwardRef<TrovySignupHandle, TrovySignupProps>(function TrovySignup(props, ref) {
    const { publishableKey, theme, title, linkUrl, id, className, style, unavailableFallback } = props;

    const hostRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<WidgetHandle | null>(null);
    const reportedRef = useRef<string | null>(null);
    const [view, setView] = useState<View>(LOADING);

    // The iframe must survive a re-render. Callbacks are therefore read at the
    // moment they are needed, and only the things that change what the frame
    // IS take part in the effect below: an inline arrow function or a fresh
    // `theme` object with the same values remounts nothing.
    const latest = useRef(props);
    useEffect(() => {
      latest.current = props;
    });

    const themeKey = JSON.stringify(sanitiseTheme(theme));
    const hasOnSuccess = typeof props.onSuccess === "function";

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      let handle: WidgetHandle;
      try {
        handle = mount(host, {
          publishableKey,
          theme: latest.current.theme,
          title,
          onError: (error) => {
            if (error.stage === "link") setView((current) => ({ ...current, linkError: error }));
            latest.current.onError?.(error);
          },
          onStateChange: (state) => {
            // Any move away from `link-failed` takes its notice down: a retry
            // in flight must not sit under "we could not connect".
            setView((current) => (state === "link-failed" ? { ...current, state } : { state }));
            latest.current.onStateChange?.(state);
          },
          // Both are passed through when both are given, so that the loader's
          // own "exactly one of" is what a JavaScript caller hears.
          ...(linkUrl !== undefined ? { linkUrl, onLinked: (customer) => latest.current.onLinked?.(customer) } : {}),
          ...(hasOnSuccess ? { onSuccess: (payload) => latest.current.onSuccess?.(payload) } : {}),
        } as MountOptions);
      } catch (error) {
        // A component that throws takes the partner's whole page down with it,
        // in production, over a sign-up form. It reports instead.
        const message = isTrovyConfigError(error) ? error.message : "Trovy: the sign-up form could not start.";
        if (!logged.has(message)) {
          logged.add(message);
          console.error(message);
        }
        if (reportedRef.current !== message) {
          reportedRef.current = message;
          latest.current.onError?.({ stage: "config", code: "INVALID_CONFIG", message });
        }
        setView({ state: "unavailable", configError: message });
        return () => setView(LOADING);
      }

      handleRef.current = handle;
      return () => {
        // Whatever the link request is doing, it is left to finish: aborting
        // would not un-spend the token.
        handle.unmount();
        handleRef.current = null;
        setView(LOADING);
      };
    }, [publishableKey, themeKey, title, linkUrl, hasOnSuccess]);

    useImperativeHandle(
      ref,
      () => ({
        reset: () => handleRef.current?.reset(),
        retry: () => handleRef.current?.retryLink() ?? false,
      }),
      [],
    );

    return (
      <div id={id} className={className} style={style} data-trovy-state={view.state}>
        {/* React renders nothing into this element, ever: it belongs to the loader. */}
        <div ref={hostRef} />
        {view.state === "unavailable" ? unavailableFallback : null}
        {view.configError && isDevelopment() ? (
          <pre role="alert" data-trovy-config-error="" style={CONFIG_ERROR_STYLE}>
            {view.configError}
          </pre>
        ) : null}
        {view.linkError
          ? (props.renderLinkFailed ?? defaultLinkFailed)({
              error: view.linkError,
              retry: () => void handleRef.current?.retryLink(),
              reset: () => handleRef.current?.reset(),
            })
          : null}
      </div>
    );
  });
  TrovySignup.displayName = "TrovySignup";
  return TrovySignup;
}

const CONFIG_ERROR_STYLE: CSSProperties = {
  margin: 0,
  padding: "12px",
  whiteSpace: "pre-wrap",
  font: "12px/1.5 ui-monospace, monospace",
  color: "#7f1d1d",
  background: "#fef2f2",
  border: "1px solid #fecaca",
};

/**
 * Whether to show a developer the mistake on the page itself. Best effort: a
 * bundler that replaces `process.env.NODE_ENV` decides it at build time, and
 * where there is no `process` at all the answer is no.
 */
function isDevelopment(): boolean {
  // eslint-disable-next-line no-restricted-globals -- read only when it exists; every bundler replaces the expression
  return typeof process !== "undefined" && process.env.NODE_ENV !== "production";
}

/** Unstyled on purpose: it inherits the page. Target `[data-trovy-notice]` to dress it. */
function defaultLinkFailed({ error, retry, reset }: LinkFailedView): ReactNode {
  const recovery = error.recovery ?? "developer";
  const { text, action } = NOTICE[recovery];
  return (
    <div role="alert" data-trovy-notice={recovery}>
      <p>{text}</p>
      {action ? (
        <button type="button" onClick={recovery === "verify-again" ? reset : retry}>
          {action}
        </button>
      ) : null}
    </div>
  );
}
