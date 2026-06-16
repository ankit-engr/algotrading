import os
import sys
import urllib.parse
import httpx
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Use provided credentials from env or default fallback
api_key = os.getenv("API_KEY", "50f6dca3-5750-4530-b51b-bfa4ae1df72f")
api_secret = os.getenv("API_SECRET", "blywjwp31p")

def test_connection():
    print("=" * 60)
    print("           UPSTOX API V2 CONNECTION DIAGNOSTIC")
    print("=" * 60)
    print(f"API Key   : {api_key}")
    print(f"API Secret: {api_secret}")
    print("-" * 60)

    # 1. Ask for Redirect URI
    redirect_uri = input("Enter your registered Redirect URI (default: http://localhost:8000/): ").strip()
    if not redirect_uri:
        redirect_uri = "http://localhost:8000/"

    # Encode the redirect_uri
    encoded_redirect = urllib.parse.quote(redirect_uri)
    
    # 2. Build Login URL
    login_url = f"https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id={api_key}&redirect_uri={encoded_redirect}"
    
    print("\n[ACTION REQUIRED]")
    print("1. Open the following link in your web browser:")
    print("-" * 60)
    print(login_url)
    print("-" * 60)
    print("2. Log in using your Upstox credentials and complete OTP verification.")
    print("3. You will be redirected to a blank page or a page that says 'site can't be reached'.")
    print("4. Copy the complete URL of that page (or copy the 'code' query parameter).")
    print("-" * 60)

    # 3. Get Code from User
    user_input = input("Paste the redirected URL or Code here: ").strip()
    if not user_input:
        print("[ERR] Code input cannot be empty.")
        sys.exit(1)

    # Parse code if user pasted the entire URL
    code = user_input
    if "code=" in user_input:
        parsed = urllib.parse.urlparse(user_input)
        queries = urllib.parse.parse_qs(parsed.query)
        if "code" in queries:
            code = queries["code"][0]
            print(f"-> Extracted Code: {code}")

    # 4. Exchange Code for Access Token
    print("\nExchanging code for Access Token...")
    token_url = "https://api.upstox.com/v2/login/authorization/token"
    headers = {
        "accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {
        "code": code,
        "client_id": api_key,
        "client_secret": api_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code"
    }

    try:
        response = httpx.post(token_url, headers=headers, data=data, timeout=15.0)
        res_data = response.json()
        
        if response.status_code != 200 or "access_token" not in res_data:
            print(f"[ERR] Failed to generate session. HTTP {response.status_code}")
            print("Response:", res_data)
            sys.exit(1)

        access_token = res_data["access_token"]
        user_name = res_data.get("user_name", "User")
        print("-> Session Generation: SUCCESSFUL")
        print(f"   Logged in user: {user_name}")
        print(f"   Access Token  : {access_token[:15]}...")
        print("-" * 60)

        # 5. Fetch Live Quote (Nifty Bank)
        print("Fetching Live Quote for Nifty Bank (NSE_INDEX|Nifty Bank)...")
        quote_url = "https://api.upstox.com/v2/market-quote/ltp"
        quote_headers = {
            "accept": "application/json",
            "Authorization": f"Bearer {access_token}"
        }
        quote_params = {
            "instrument_key": "NSE_INDEX|Nifty Bank"
        }

        quote_response = httpx.get(quote_url, headers=quote_headers, params=quote_params, timeout=15.0)
        quote_data = quote_response.json()

        if quote_response.status_code == 200 and quote_data.get("status") == "success":
            # Upstox responses can return key as NSE_INDEX:Nifty Bank or NSE_INDEX|Nifty Bank
            data_map = quote_data.get("data", {})
            ltp_info = data_map.get("NSE_INDEX:Nifty Bank") or data_map.get("NSE_INDEX|Nifty Bank")
            
            print("   -> Fetch Live Quote: SUCCESSFUL")
            print("   Response Data:", ltp_info)
        else:
            print("[WARN] Failed to fetch live quote.")
            print("Response:", quote_data)

        # 6. Fetch Intraday Candles (Nifty Bank 5m)
        print("\nFetching 5-minute Intraday Candles for Nifty Bank...")
        encoded_key = urllib.parse.quote("NSE_INDEX|Nifty Bank")
        candles_url = f"https://api.upstox.com/v2/historical-candle/intraday/{encoded_key}/5minute"
        
        candles_response = httpx.get(candles_url, headers=quote_headers, timeout=15.0)
        candles_data = candles_response.json()

        if candles_response.status_code == 200 and candles_data.get("status") == "success":
            candles_list = candles_data.get("data", {}).get("candles", [])
            print(f"   -> Fetch Intraday Candles: SUCCESSFUL ({len(candles_list)} candles returned)")
            if candles_list:
                print("   Newest Candle:", candles_list[0])
            
            print("\n" + "=" * 60)
            print("🎉 SUCCESS! Upstox API v2 integration test completed successfully!")
            print("=" * 60)
        else:
            print("[WARN] Failed to fetch intraday candles.")
            print("Response:", candles_data)

    except Exception as e:
        print(f"\n[ERR] Exception occurred: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    test_connection()
