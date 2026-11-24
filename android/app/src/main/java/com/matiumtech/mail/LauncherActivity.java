/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.matiumtech.mail;

import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.window.SplashScreenView;

import androidx.browser.customtabs.CustomTabsClient;



public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    /**
     * Android 12+ plays the "mt" shards animation (res/drawable-v31/splash_anim.xml)
     * in the system splash. Chrome is warmed up meanwhile and opened the moment
     * the animation ends; its own splash shows the finished mark in the same
     * place until the page has painted. Never wait longer than this:
     */
    private static final long MAX_SPLASH_MS = 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean launched;
    private SplashScreenView splashView;


    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !isFinishing()) {
            // Start the browser now so its start-up overlaps the animation.
            String browser = CustomTabsClient.getPackageName(this, null);
            if (browser != null) CustomTabsClient.connectAndInitialize(getApplicationContext(), browser);

            getSplashScreen().setOnExitAnimationListener(view -> {
                // Keep the splash (and its finished mark) on screen until Chrome covers it.
                splashView = view;
                long end = view.getIconAnimationStart().toEpochMilli() + view.getIconAnimationDuration().toMillis();
                handler.postDelayed(this::launchOnce, Math.max(0, end - SystemClock.uptimeMillis()));
            });
            // No splash shown (e.g. opened from a link): don't wait for one.
            handler.postDelayed(this::launchOnce, MAX_SPLASH_MS);
        }
    }

    @Override
    protected boolean shouldLaunchImmediately() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S;
    }

    private void launchOnce() {
        if (launched || isFinishing()) return;
        launched = true;
        launchTwa();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Chrome is in front now; the splash view is no longer needed.
        if (splashView != null) {
            splashView.remove();
            splashView = null;
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Get the original launch Url.
        Uri uri = super.getLaunchingUrl();

        

        return uri;
    }
}
