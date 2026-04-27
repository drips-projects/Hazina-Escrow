#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String, Vec, token,
};

// ─── Storage keys ───────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    PlatformFee,    // basis points (500 = 5%)
    EscrowCount,
}

#[contracttype]
pub enum EscrowKey {
    Record(u64),    // escrow_id → EscrowRecord
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialised = 1,
    NotAdmin = 2,
    EscrowNotFound = 3,
    AlreadyReleased = 4,
    AlreadyRefunded = 5,
    NotBuyer = 6,
    NotExpired = 7,
    InvalidInput = 8,
}

// ─── Data types ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct EscrowRecord {
    pub escrow_id:  u64,
    pub dataset_id: String,     // e.g. "ds-003-defi-yields"
    pub buyer:      Address,
    pub seller:     Address,
    pub amount:     i128,       // USDC amount in stroops (7 decimals)
    pub token:      Address,    // USDC contract address
    pub released:   bool,
    pub refunded:   bool,
}

#[contracttype]
#[derive(Clone)]
pub struct SellerShare {
    pub seller: Address,
    pub amount: i128,
}

// ─── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct HazinaEscrow;

#[contractimpl]
impl HazinaEscrow {

    /// One-time initialisation. Call after deployment.
    pub fn initialize(env: Env, admin: Address, platform_fee_bps: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialised);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PlatformFee, &platform_fee_bps);
        env.storage().instance().set(&DataKey::EscrowCount, &0u64);
        Ok(())
    }

    /// Buyer calls this to lock tokens in escrow for a dataset query.
    /// Supports any token on Stellar (USDC, XLM, EURC, etc.).
    /// Returns the escrow_id the buyer must share with the backend.
    ///
    /// # Arguments
    /// * `buyer` - The account locking funds
    /// * `seller` - The account that will receive funds if released
    /// * `token` - The token contract address (supports any SPL/Stellar token)
    /// * `amount` - Token amount in the token's base unit (stroops for native assets, 7 decimals typically)
    /// * `dataset_id` - Human-readable dataset identifier for indexing
    pub fn lock(
        env:        Env,
        buyer:      Address,
        seller:     Address,
        token:      Address,
        amount:     i128,
        dataset_id: String,
    ) -> Result<u64, Error> {
        buyer.require_auth();

        // Transfer USDC from buyer → this contract
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        // Record escrow
        let id: u64 = env.storage().instance().get(&DataKey::EscrowCount).unwrap_or(0);
        let record = EscrowRecord {
            escrow_id: id,
            dataset_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            amount,
            token: token.clone(),
            released: false,
            refunded: false,
        };
        env.storage().persistent().set(&EscrowKey::Record(id), &record);
        env.storage().instance().set(&DataKey::EscrowCount, &(id + 1));

        // Emit event so the backend can index it
        env.events().publish(
            (soroban_sdk::symbol_short!("locked"),),
            (id, buyer, seller, amount),
        );

        Ok(id)
    }

    /// Buyer calls this to lock one payment split across multiple sellers.
    /// Returns the first escrow id that was created.
    pub fn lock_multi(
        env: Env,
        buyer: Address,
        token: Address,
        shares: Vec<SellerShare>,
        dataset_ids: Vec<String>,
    ) -> Result<u64, Error> {
        buyer.require_auth();

        if shares.is_empty() || shares.len() != dataset_ids.len() {
            return Err(Error::InvalidInput);
        }

        let first_id: u64 = env.storage().instance().get(&DataKey::EscrowCount).unwrap_or(0);
        let mut total_amount: i128 = 0;

        let mut i: u32 = 0;
        while i < shares.len() {
            let share = match shares.get(i) {
                Some(share) => share,
                None => return Err(Error::InvalidInput),
            };
            total_amount += share.amount;
            i += 1;
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &total_amount);

        let mut next_id = first_id;
        let mut j: u32 = 0;
        while j < shares.len() {
            let share = match shares.get(j) {
                Some(share) => share,
                None => return Err(Error::InvalidInput),
            };
            let dataset_id = match dataset_ids.get(j) {
                Some(dataset_id) => dataset_id,
                None => return Err(Error::InvalidInput),
            };
            let record = EscrowRecord {
                escrow_id: next_id,
                dataset_id,
                buyer: buyer.clone(),
                seller: share.seller,
                amount: share.amount,
                token: token.clone(),
                released: false,
                refunded: false,
            };
            env.storage()
                .persistent()
                .set(&EscrowKey::Record(next_id), &record);
            next_id += 1;
            j += 1;
        }

        env.storage().instance().set(&DataKey::EscrowCount, &next_id);

        env.events().publish(
            (String::from_str(&env, "locked_multi"),),
            (first_id, buyer, total_amount, shares.len()),
        );

        Ok(first_id)
    }

    /// Admin (Hazina backend) calls this after verifying the data was delivered.
    /// Sends 95% to seller and 5% to admin (platform fee).
    pub fn release(env: Env, admin: Address, escrow_id: u64) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin)?;
        Self::release_one(&env, &admin, escrow_id)
    }

    /// Admin (Hazina backend) atomically releases many escrows in one call.
    pub fn release_multi(env: Env, admin: Address, escrow_ids: Vec<u64>) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin)?;

        let mut i: u32 = 0;
        while i < escrow_ids.len() {
            let escrow_id = match escrow_ids.get(i) {
                Some(escrow_id) => escrow_id,
                None => return Err(Error::EscrowNotFound),
            };
            Self::release_one(&env, &admin, escrow_id)?;
            i += 1;
        }
        Ok(())
    }

    /// Admin can refund buyer if something goes wrong.
    pub fn refund(env: Env, admin: Address, escrow_id: u64) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin)?;

        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .ok_or(Error::EscrowNotFound)?;

        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.buyer, &record.amount);

        record.refunded = true;
        env.storage().persistent().set(&EscrowKey::Record(escrow_id), &record);

        env.events().publish(
            (soroban_sdk::symbol_short!("refunded"),),
            (escrow_id, record.buyer, record.amount),
        );
        Ok(())
    }

    /// Read an escrow record.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowRecord, Error> {
        env.storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .ok_or(Error::EscrowNotFound)
    }

    /// Read current platform fee in basis points.
    pub fn get_fee(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::PlatformFee).unwrap_or(500)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn assert_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::AlreadyInitialised)?;
        if admin != *caller {
            return Err(Error::NotAdmin);
        }
        Ok(())
    }

    fn release_one(env: &Env, admin: &Address, escrow_id: u64) -> Result<(), Error> {
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .ok_or(Error::EscrowNotFound)?;

        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }

        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFee)
            .unwrap_or(500);

        let platform_cut = record.amount * fee_bps as i128 / 10_000;
        let seller_cut = record.amount - platform_cut;

        let token_client = token::Client::new(env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.seller, &seller_cut);
        token_client.transfer(&env.current_contract_address(), admin, &platform_cut);

        record.released = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        env.events().publish(
            (soroban_sdk::symbol_short!("released"),),
            (escrow_id, record.seller, seller_cut, platform_cut),
        );
        Ok(())
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Env, String, Vec,
    };

    fn setup() -> (Env, HazinaEscrowClient<'static>, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin  = Address::generate(&env);
        let buyer  = Address::generate(&env);
        let seller = Address::generate(&env);

        // Deploy a mock USDC token
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let usdc_admin = StellarAssetClient::new(&env, &usdc);
        usdc_admin.mint(&buyer, &1_000_0000000); // 1000 USDC (7 decimal places)

        // Deploy escrow contract
        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &500); // 5% fee

        (env, client, admin, buyer, seller, usdc)
    }

    #[test]
    fn test_lock_and_release() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let amount: i128 = 2_000_000; // 0.2 USDC
        let dataset_id = String::from_str(&env, "ds-003-defi-yields");

        // Lock funds
        let escrow_id = client.lock(&buyer, &seller, &usdc, &amount, &dataset_id);
        assert_eq!(escrow_id, 0);
        assert_eq!(token_client.balance(&buyer), 1_000_0000000 - amount);

        // Release → seller gets 95%, admin gets 5%
        client.release(&admin, &escrow_id);

        let seller_expected = amount * 95 / 100;
        let admin_expected  = amount - seller_expected;
        assert_eq!(token_client.balance(&seller), seller_expected);
        assert_eq!(token_client.balance(&admin),  admin_expected);
        let _events = env.events().all();
    }

    #[test]
    fn test_refund() {
        let (env, client, admin, buyer, _seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 5_000_000; // 0.5 USDC

        let id = client.lock(
            &buyer, &Address::generate(&env), &usdc, &amount,
            &String::from_str(&env, "ds-001"),
        );
        client.refund(&admin, &id);

        // Buyer gets full refund
        assert_eq!(token_client.balance(&buyer), 1_000_0000000);
    }

    #[test]
    fn test_lock_multi_and_release_multi() {
        let (env, client, admin, buyer, _seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let seller_1 = Address::generate(&env);
        let seller_2 = Address::generate(&env);
        let seller_3 = Address::generate(&env);
        let seller_4 = Address::generate(&env);

        let amount_1: i128 = 1_000_000;
        let amount_2: i128 = 2_000_000;
        let amount_3: i128 = 3_000_000;
        let amount_4: i128 = 4_000_000;
        let total = amount_1 + amount_2 + amount_3 + amount_4;

        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: seller_1.clone(),
            amount: amount_1,
        });
        shares.push_back(SellerShare {
            seller: seller_2.clone(),
            amount: amount_2,
        });
        shares.push_back(SellerShare {
            seller: seller_3.clone(),
            amount: amount_3,
        });
        shares.push_back(SellerShare {
            seller: seller_4.clone(),
            amount: amount_4,
        });

        let mut dataset_ids = Vec::new(&env);
        dataset_ids.push_back(String::from_str(&env, "ds-001"));
        dataset_ids.push_back(String::from_str(&env, "ds-002"));
        dataset_ids.push_back(String::from_str(&env, "ds-003"));
        dataset_ids.push_back(String::from_str(&env, "ds-004"));

        let first_id = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
        assert_eq!(first_id, 0);
        assert_eq!(token_client.balance(&buyer), 1_000_0000000 - total);

        let mut escrow_ids = Vec::new(&env);
        escrow_ids.push_back(first_id);
        escrow_ids.push_back(first_id + 1);
        escrow_ids.push_back(first_id + 2);
        escrow_ids.push_back(first_id + 3);

        client.release_multi(&admin, &escrow_ids);

        let s1_expected = amount_1 * 95 / 100;
        let s2_expected = amount_2 * 95 / 100;
        let s3_expected = amount_3 * 95 / 100;
        let s4_expected = amount_4 * 95 / 100;
        let admin_expected =
            (amount_1 - s1_expected) + (amount_2 - s2_expected) + (amount_3 - s3_expected) + (amount_4 - s4_expected);

        assert_eq!(token_client.balance(&seller_1), s1_expected);
        assert_eq!(token_client.balance(&seller_2), s2_expected);
        assert_eq!(token_client.balance(&seller_3), s3_expected);
        assert_eq!(token_client.balance(&seller_4), s4_expected);
        assert_eq!(token_client.balance(&admin), admin_expected);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_empty_shares() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let shares: Vec<SellerShare> = Vec::new(&env);
        let dataset_ids: Vec<String> = Vec::new(&env);

        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_mismatched_lengths() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: Address::generate(&env),
            amount: 1_000_000,
        });

        let dataset_ids: Vec<String> = Vec::new(&env);
        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_error_already_initialised() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.initialize(&admin, &500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_error_not_admin() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let amount: i128 = 1_000_000;
        let id = client.lock(&buyer, &seller, &usdc, &amount, &String::from_str(&env, "ds-101"));
        client.release(&buyer, &id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_error_escrow_not_found() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.get_escrow(&999);
        client.refund(&admin, &999);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_error_already_released() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let amount: i128 = 1_000_000;
        let id = client.lock(&buyer, &seller, &usdc, &amount, &String::from_str(&env, "ds-102"));
        client.release(&admin, &id);
        client.release(&admin, &id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_error_already_refunded() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let amount: i128 = 1_000_000;
        let id = client.lock(&buyer, &seller, &usdc, &amount, &String::from_str(&env, "ds-103"));
        client.refund(&admin, &id);
        client.refund(&admin, &id);
    }

    #[test]
    fn test_error_not_buyer_code_value() {
        assert_eq!(Error::NotBuyer as u32, 6);
    }
}
