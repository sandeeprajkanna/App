import Onyx from 'react-native-onyx';
import Str from 'expensify-common/lib/str';
import _ from 'underscore';
import ONYXKEYS from '../../../ONYXKEYS';
import redirectToSignIn from '../SignInRedirect';
import * as DeprecatedAPI from '../../deprecatedAPI';
import CONFIG from '../../../CONFIG';
import Log from '../../Log';
import PushNotification from '../../Notification/PushNotification';
import Timing from '../Timing';
import CONST from '../../../CONST';
import Navigation from '../../Navigation/Navigation';
import ROUTES from '../../../ROUTES';
import * as Localize from '../../Localize';
import UnreadIndicatorUpdater from '../../UnreadIndicatorUpdater';
import Timers from '../../Timers';
import * as Pusher from '../../Pusher/pusher';
import NetworkConnection from '../../NetworkConnection';
import * as User from '../User';
import * as ValidationUtils from '../../ValidationUtils';
import * as Authentication from '../../Authentication';
import * as ErrorUtils from '../../ErrorUtils';
import * as Welcome from '../Welcome';

let credentials = {};
Onyx.connect({
    key: ONYXKEYS.CREDENTIALS,
    callback: val => credentials = val,
});

/**
 * Sets API data in the store when we make a successful "Authenticate"/"CreateLogin" request
 *
 * @param {Object} data
 * @param {String} data.accountID
 * @param {String} data.authToken
 * @param {String} data.email
 */
function setSuccessfulSignInData(data) {
    PushNotification.register(data.accountID);
    Onyx.merge(ONYXKEYS.SESSION, {
        shouldShowComposeInput: true,
        error: null,
        ..._.pick(data, 'authToken', 'accountID', 'email', 'encryptedAuthToken'),
    });
}

/**
 * Create an account for the user logging in.
 * This will send them a notification with a link to click on to validate the account and set a password
 *
 * @param {String} login
 */
function createAccount(login) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {error: ''});

    DeprecatedAPI.User_SignUp({
        email: login,
    }).then((response) => {
        // A 405 means that the account needs to be validated. We should let the user proceed to the ResendValidationForm view.
        if (response.jsonCode === 200 || response.jsonCode === 405) {
            return;
        }

        Onyx.merge(ONYXKEYS.CREDENTIALS, {login: null});
        Onyx.merge(ONYXKEYS.ACCOUNT, {error: response.message || `Unknown API Error: ${response.jsonCode}`});
    });
}

/**
 * Clears the Onyx store and redirects user to the sign in page
 */
function signOut() {
    Log.info('Flushing logs before signing out', true, {}, true);
    if (credentials && credentials.autoGeneratedLogin) {
        // Clean up the login that we created
        DeprecatedAPI.DeleteLogin({
            partnerUserID: credentials.autoGeneratedLogin,
            partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
            partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
            shouldRetry: false,
        })
            .then((response) => {
                if (response.jsonCode === CONST.JSON_CODE.SUCCESS) {
                    return;
                }

                Onyx.merge(ONYXKEYS.SESSION, {error: response.message});
            });
    }
    Onyx.set(ONYXKEYS.SESSION, null);
    Onyx.set(ONYXKEYS.CREDENTIALS, null);
    Timing.clearData();
}

function signOutAndRedirectToSignIn() {
    signOut();
    redirectToSignIn();
    Log.info('Redirecting to Sign In because signOut() was called');
}

/**
 * Reopen the account and send the user a link to set password
 *
 * @param {String} [login]
 */
function reopenAccount(login = credentials.login) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {loading: true});
    DeprecatedAPI.User_ReopenAccount({email: login})
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

/**
 * Resend the validation link to the user that is validating their account
 *
 * @param {String} [login]
 */
function resendValidationLink(login = credentials.login) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {loading: true});
    DeprecatedAPI.ResendValidateCode({email: login})
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

/**
 * Checks the API to see if an account exists for the given login
 *
 * @param {String} login
 */
function fetchAccountDetails(login) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {...CONST.DEFAULT_ACCOUNT_DATA, loading: true});

    DeprecatedAPI.GetAccountStatus({email: login, forceNetworkRequest: true})
        .then((response) => {
            if (response.jsonCode === 200) {
                Onyx.merge(ONYXKEYS.CREDENTIALS, {
                    login: response.normalizedLogin,
                });
                Onyx.merge(ONYXKEYS.ACCOUNT, {
                    accountExists: response.accountExists,
                    validated: response.validated,
                    closed: response.isClosed,
                    forgotPassword: false,
                    validateCodeExpired: false,
                });

                if (!response.accountExists) {
                    createAccount(login);
                } else if (response.isClosed) {
                    reopenAccount(login);
                } else if (!response.validated) {
                    resendValidationLink(login);
                }
            } else if (response.jsonCode === 402) {
                Onyx.merge(ONYXKEYS.ACCOUNT, {
                    error: ValidationUtils.isNumericWithSpecialChars(login)
                        ? Localize.translateLocal('common.error.phoneNumber')
                        : Localize.translateLocal('loginForm.error.invalidFormatEmailLogin'),
                });
            } else if (response.jsonCode === CONST.JSON_CODE.UNABLE_TO_RETRY) {
                Onyx.merge(ONYXKEYS.ACCOUNT, {error: Localize.translateLocal('session.offlineMessageRetry')});
            } else {
                Onyx.merge(ONYXKEYS.ACCOUNT, {error: response.message});
            }
        })
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

/**
 *
 * Will create a temporary login for the user in the passed authenticate response which is used when
 * re-authenticating after an authToken expires.
 *
 * @param {String} authToken
 * @param {String} email
 * @return {Promise}
 */
function createTemporaryLogin(authToken, email) {
    const autoGeneratedLogin = Str.guid('expensify.cash-');
    const autoGeneratedPassword = Str.guid();

    return DeprecatedAPI.CreateLogin({
        authToken,
        partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
        partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
        partnerUserID: autoGeneratedLogin,
        partnerUserSecret: autoGeneratedPassword,
        shouldRetry: false,
        forceNetworkRequest: true,
        email,
        includeEncryptedAuthToken: true,
    })
        .then((createLoginResponse) => {
            if (createLoginResponse.jsonCode !== 200) {
                Onyx.merge(ONYXKEYS.ACCOUNT, {error: createLoginResponse.message});
                return createLoginResponse;
            }

            setSuccessfulSignInData(createLoginResponse);

            // If we have an old generated login for some reason
            // we should delete it before storing the new details
            if (credentials && credentials.autoGeneratedLogin) {
                DeprecatedAPI.DeleteLogin({
                    partnerUserID: credentials.autoGeneratedLogin,
                    partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
                    partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
                    shouldRetry: false,
                })
                    .then((response) => {
                        if (response.jsonCode === CONST.JSON_CODE.SUCCESS) {
                            return;
                        }

                        Log.hmmm('[Session] Unable to delete login', false, {message: response.message, jsonCode: response.jsonCode});
                    });
            }

            Onyx.merge(ONYXKEYS.CREDENTIALS, {
                autoGeneratedLogin,
                autoGeneratedPassword,
            });
            return createLoginResponse;
        })
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

/**
 * Sign the user into the application. This will first authenticate their account
 * then it will create a temporary login for them which is used when re-authenticating
 * after an authToken expires.
 *
 * @param {String} password
 * @param {String} [twoFactorAuthCode]
 */
function signIn(password, twoFactorAuthCode) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {...CONST.DEFAULT_ACCOUNT_DATA, loading: true});

    Authentication.Authenticate({
        useExpensifyLogin: true,
        partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
        partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
        partnerUserID: credentials.login,
        partnerUserSecret: password,
        twoFactorAuthCode,
        email: credentials.login,
    })
        .then((response) => {
            if (response.jsonCode !== 200) {
                const errorMessage = ErrorUtils.getAuthenticateErrorMessage(response);
                if (errorMessage === 'passwordForm.error.twoFactorAuthenticationEnabled') {
                    Onyx.merge(ONYXKEYS.ACCOUNT, {requiresTwoFactorAuth: true, loading: false});
                    return;
                }
                Onyx.merge(ONYXKEYS.ACCOUNT, {error: Localize.translateLocal(errorMessage), loading: false});
                return;
            }

            const {authToken, email} = response;
            createTemporaryLogin(authToken, email);
        });
}

/**
 * Uses a short lived authToken to continue a user's session from OldDot
 *
 * @param {String} email
 * @param {String} shortLivedToken
 * @param {String} exitTo
 */
function signInWithShortLivedToken(email, shortLivedToken) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {...CONST.DEFAULT_ACCOUNT_DATA, loading: true});

    createTemporaryLogin(shortLivedToken, email)
        .then((response) => {
            if (response.jsonCode !== CONST.JSON_CODE.SUCCESS) {
                return;
            }

            User.getUserDetails();
            Onyx.merge(ONYXKEYS.ACCOUNT, {success: true});
        }).finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

/**
 * User forgot the password so let's send them the link to reset their password
 */
function resetPassword() {
    Onyx.merge(ONYXKEYS.ACCOUNT, {loading: true, forgotPassword: true});
    DeprecatedAPI.ResetPassword({email: credentials.login})
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false, validateCodeExpired: false});
        });
}

/**
 * Set the password for the current account.
 * Then it will create a temporary login for them which is used when re-authenticating
 * after an authToken expires.
 *
 * @param {String} password
 * @param {String} validateCode
 * @param {Number} accountID
 */
function setPassword(password, validateCode, accountID) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {...CONST.DEFAULT_ACCOUNT_DATA, loading: true, validateCodeExpired: false});
    DeprecatedAPI.SetPassword({
        password,
        validateCode,
        accountID,
    })
        .then((response) => {
            if (response.jsonCode === 200) {
                createTemporaryLogin(response.authToken, response.email);
                return;
            }

            // This request can fail if the password is not complex enough
            Onyx.merge(ONYXKEYS.ACCOUNT, {error: response.message});
        })
        .finally(() => {
            Onyx.merge(ONYXKEYS.ACCOUNT, {loading: false});
        });
}

function invalidateCredentials() {
    Onyx.merge(ONYXKEYS.CREDENTIALS, {autoGeneratedLogin: '', autoGeneratedPassword: ''});
}

/**
 * Clear the credentials and partial sign in session so the user can taken back to first Login step
 */
function clearSignInData() {
    Onyx.multiSet({
        [ONYXKEYS.ACCOUNT]: null,
        [ONYXKEYS.CREDENTIALS]: null,
    });
}

/**
 * Put any logic that needs to run when we are signed out here. This can be triggered when the current tab or another tab signs out.
 */
function cleanupSession() {
    // We got signed out in this tab or another so clean up any subscriptions and timers
    NetworkConnection.stopListeningForReconnect();
    UnreadIndicatorUpdater.stopListeningForReportChanges();
    PushNotification.deregister();
    PushNotification.clearNotifications();
    Pusher.disconnect();
    Timers.clearAll();
    Welcome.resetReadyCheck();
}

function clearAccountMessages() {
    Onyx.merge(ONYXKEYS.ACCOUNT, {error: '', success: ''});
}

/**
 * Calls change password and signs if if successful. Otherwise, we request a new magic link
 * if we know the account email. Otherwise or finally we redirect to the root of the nav.
 * @param {String} authToken
 * @param {String} password
 */
function changePasswordAndSignIn(authToken, password) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {validateSessionExpired: false});
    DeprecatedAPI.ChangePassword({
        authToken,
        password,
    })
        .then((responsePassword) => {
            Onyx.merge(ONYXKEYS.USER_SIGN_UP, {authToken: null});
            if (responsePassword.jsonCode === 200) {
                signIn(password);
                return;
            }
            if (responsePassword.jsonCode === CONST.JSON_CODE.NOT_AUTHENTICATED && !credentials.login) {
                // authToken has expired, and we don't have the email set to request a new magic link.
                // send user to login page to enter email.
                Navigation.navigate(ROUTES.HOME);
                return;
            }
            if (responsePassword.jsonCode === CONST.JSON_CODE.NOT_AUTHENTICATED) {
                // authToken has expired, and we have the account email, so we request a new magic link.
                Onyx.merge(ONYXKEYS.ACCOUNT, {accountExists: true, validateCodeExpired: true, error: null});
                resetPassword();
                Navigation.navigate(ROUTES.HOME);
                return;
            }
            Onyx.merge(ONYXKEYS.SESSION, {error: 'setPasswordPage.passwordNotSet'});
        });
}

/**
 * @param {Number} accountID
 * @param {String} validateCode
 * @param {String} login
 * @param {String} authToken
 */
function validateEmail(accountID, validateCode) {
    Onyx.merge(ONYXKEYS.USER_SIGN_UP, {isValidating: true});
    Onyx.merge(ONYXKEYS.SESSION, {error: ''});
    DeprecatedAPI.ValidateEmail({
        accountID,
        validateCode,
    })
        .then((responseValidate) => {
            if (responseValidate.jsonCode === 200) {
                Onyx.merge(ONYXKEYS.USER_SIGN_UP, {authToken: responseValidate.authToken});
                Onyx.merge(ONYXKEYS.ACCOUNT, {accountExists: true, validated: true});
                Onyx.merge(ONYXKEYS.CREDENTIALS, {login: responseValidate.email});
                return;
            }
            if (responseValidate.jsonCode === 666) {
                Onyx.merge(ONYXKEYS.ACCOUNT, {accountExists: true, validated: true});
            }
            if (responseValidate.jsonCode === 401) {
                Onyx.merge(ONYXKEYS.SESSION, {error: 'setPasswordPage.setPasswordLinkInvalid'});
            }
        })
        .finally(Onyx.merge(ONYXKEYS.USER_SIGN_UP, {isValidating: false}));
}

// It's necessary to throttle requests to reauthenticate since calling this multiple times will cause Pusher to
// reconnect each time when we only need to reconnect once. This way, if an authToken is expired and we try to
// subscribe to a bunch of channels at once we will only reauthenticate and force reconnect Pusher once.
const reauthenticatePusher = _.throttle(() => {
    Log.info('[Pusher] Re-authenticating and then reconnecting');
    Authentication.reauthenticate('Push_Authenticate')
        .then(Pusher.reconnect)
        .catch(() => {
            console.debug(
                '[PusherConnectionManager]',
                'Unable to re-authenticate Pusher because we are offline.',
            );
        });
}, 5000, {trailing: false});

/**
 * @param {String} socketID
 * @param {String} channelName
 * @param {Function} callback
 */
function authenticatePusher(socketID, channelName, callback) {
    Log.info('[PusherAuthorizer] Attempting to authorize Pusher', false, {channelName});

    DeprecatedAPI.Push_Authenticate({
        socket_id: socketID,
        channel_name: channelName,
        shouldRetry: false,
        forceNetworkRequest: true,
    })
        .then((response) => {
            if (response.jsonCode === CONST.JSON_CODE.NOT_AUTHENTICATED) {
                Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher because authToken is expired');
                callback(new Error('Pusher failed to authenticate because authToken is expired'), {auth: ''});

                // Attempt to refresh the authToken then reconnect to Pusher
                reauthenticatePusher();
                return;
            }

            if (response.jsonCode !== CONST.JSON_CODE.SUCCESS) {
                Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher for reason other than expired session');
                callback(new Error(`Pusher failed to authenticate because code: ${response.jsonCode} message: ${response.message}`), {auth: ''});
                return;
            }

            Log.info(
                '[PusherAuthorizer] Pusher authenticated successfully',
                false,
                {channelName},
            );
            callback(null, response);
        })
        .catch((error) => {
            Log.hmmm('[PusherAuthorizer] Unhandled error: ', {channelName, error});
            callback(new Error('Push_Authenticate request failed'), {auth: ''});
        });
}

/**
 * @param {Boolean} shouldShowComposeInput
 */
function setShouldShowComposeInput(shouldShowComposeInput) {
    Onyx.merge(ONYXKEYS.SESSION, {shouldShowComposeInput});
}

export {
    fetchAccountDetails,
    setPassword,
    signIn,
    signInWithShortLivedToken,
    signOut,
    signOutAndRedirectToSignIn,
    reopenAccount,
    resendValidationLink,
    resetPassword,
    clearSignInData,
    cleanupSession,
    clearAccountMessages,
    validateEmail,
    authenticatePusher,
    reauthenticatePusher,
    setShouldShowComposeInput,
    changePasswordAndSignIn,
    invalidateCredentials,
};
